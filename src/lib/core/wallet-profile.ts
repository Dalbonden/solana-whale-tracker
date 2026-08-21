/**
 * Gathers the measurements the archetype classifier needs.
 *
 * Computed on read rather than stored. At the current roster size the whole
 * thing is four small queries, and a derived column would need a migration plus
 * a cron to stay honest — a stale "smart money" badge is worse than a slightly
 * more expensive page. If the roster reaches the hundreds this should move
 * behind the same cache pattern as `trace-store`.
 */

import { db } from '@/lib/db/client';
import { selectAllPages } from '@/lib/db/repositories';
import type { Whale, WhalePosition } from '@/types';

import {
  classifyWallet,
  median,
  stdev,
  type Archetype,
  type ArchetypeMetrics,
} from './archetypes';

/** A position is "underwater" past this drawdown from entry. */
const UNDERWATER_THRESHOLD = -0.3;

interface TradeStatRow {
  whale_address: string;
  side: string;
  usd_value: number;
  realized_pnl_usd: number | null;
  realized_pnl_pct: number | null;
  block_time: string;
  token_mint: string;
}

/**
 * Builds metrics for a set of whales in a fixed number of queries.
 *
 * Deliberately batched: doing this per whale turned the whale list into N+1
 * round trips, which is the sort of thing that only shows up once the roster
 * grows and is annoying to unpick later.
 */
export async function buildArchetypeMetrics(
  whales: Whale[]
): Promise<Map<string, { metrics: ArchetypeMetrics; archetypes: Archetype[] }>> {
  const result = new Map<string, { metrics: ArchetypeMetrics; archetypes: Archetype[] }>();
  if (!whales.length) return result;

  const addresses = whales.map((w) => w.address);
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();

  const [positions, trades, velocity, snipes, prices] = await Promise.all([
    fetchPositions(addresses),
    fetchTrades(addresses, since),
    fetchVelocity(addresses),
    fetchSnipeCounts(addresses),
    fetchPrices(),
  ]);

  for (const whale of whales) {
    const own = positions.get(whale.address) ?? [];
    const ownTrades = trades.get(whale.address) ?? [];

    // --- closed cycles: the basis for every skill and style claim ---------
    // Only cycles whose entry we actually observed can be scored. A cycle we
    // joined halfway through has no knowable return.
    const closed = own.filter((p) => p.status === 'closed' && p.basis_complete);
    const holdHours = closed.map(
      (p) =>
        (new Date(p.closed_at ?? p.last_trade_at).getTime() - new Date(p.opened_at).getTime()) /
        3_600_000
    );

    const pnlPcts = ownTrades
      .map((t) => t.realized_pnl_pct)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    const wins = ownTrades.filter((t) => (t.realized_pnl_usd ?? 0) > 0).length;
    const scored = ownTrades.filter((t) => t.realized_pnl_usd !== null).length;
    const grossProfit = ownTrades.reduce(
      (sum, t) => sum + Math.max(t.realized_pnl_usd ?? 0, 0),
      0
    );
    const grossLoss = Math.abs(
      ownTrades.reduce((sum, t) => sum + Math.min(t.realized_pnl_usd ?? 0, 0), 0)
    );

    // --- open positions: conviction and drawdown --------------------------
    const open = own.filter((p) => p.status === 'open');
    let bookValue = 0;
    let maxPosition = 0;
    let underwater = 0;
    let markable = 0;

    for (const position of open) {
      const price = prices.get(position.token_mint);
      if (price === undefined || price === null) continue;
      const value = Number(position.amount) * price;
      bookValue += value;
      maxPosition = Math.max(maxPosition, value);

      const basis = Number(position.cost_basis_usd);
      if (position.basis_complete && basis > 0) {
        markable += 1;
        if ((value - basis) / basis <= UNDERWATER_THRESHOLD) underwater += 1;
      }
    }

    /*
     * Conviction is measured against the whole portfolio, not against the sum
     * of the positions we happen to track. Dividing by the tracked subset made
     * every whale holding a single meme read as "100% of the book" while the
     * badge beside it correctly reported a $22.7M portfolio — two numbers on
     * one row contradicting each other. The snapshot covers all holdings, so it
     * is the honest denominator; the tracked sum is only a fallback for a
     * wallet that has never been snapshotted.
     */
    const book = whale.portfolio_value_usd || bookValue;

    const metrics: ArchetypeMetrics = {
      address: whale.address,
      portfolioValueUsd: whale.portfolio_value_usd,
      tradeCount30d: ownTrades.length || whale.trade_count_30d,
      distinctTokens30d: new Set(ownTrades.map((t) => t.token_mint)).size,
      avgTradeSizeUsd: whale.avg_trade_size_usd,

      closedCycles: closed.length,
      medianHoldHours: median(holdHours),
      winRate: scored > 0 ? wins / scored : null,
      profitFactor:
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 3 : null,
      realizedPnlUsd: ownTrades.reduce((sum, t) => sum + (t.realized_pnl_usd ?? 0), 0),
      pnlPctStdev: stdev(pnlPcts),

      netFlow30dUsd: ownTrades.reduce(
        (sum, t) => sum + (t.side === 'buy' ? t.usd_value : -t.usd_value),
        0
      ),
      openPositions: open.length,
      maxConvictionPct: book > 0 && maxPosition > 0 ? maxPosition / book : null,
      underwaterShare: markable > 0 ? underwater / markable : null,

      txPerHour: velocity.get(whale.address) ?? null,
      snipeCount: snipes.get(whale.address) ?? 0,
      daysTracked: (Date.now() - new Date(whale.first_seen_at).getTime()) / 86_400_000,
    };

    result.set(whale.address, { metrics, archetypes: classifyWallet(metrics) });
  }

  return result;
}

async function fetchPositions(addresses: string[]): Promise<Map<string, WhalePosition[]>> {
  const byWhale = new Map<string, WhalePosition[]>();
  // Paged: PostgREST truncates an unbounded select at 1000 rows without saying
  // so, and position rows accumulate one per entry-to-exit cycle per wallet.
  const data = await selectAllPages<WhalePosition>('fetchPositions', (from, to) =>
    db().from('whale_positions').select('*').in('whale_address', addresses).range(from, to)
  );

  for (const row of data) {
    byWhale.set(row.whale_address, [...(byWhale.get(row.whale_address) ?? []), row]);
  }
  return byWhale;
}

async function fetchTrades(
  addresses: string[],
  since: string
): Promise<Map<string, TradeStatRow[]>> {
  const byWhale = new Map<string, TradeStatRow[]>();
  const data = await selectAllPages<TradeStatRow>('fetchTrades', (from, to) =>
    db()
      .from('whale_trades')
      .select('whale_address, side, usd_value, realized_pnl_usd, realized_pnl_pct, block_time, token_mint')
      .in('whale_address', addresses)
      .gte('block_time', since)
      .range(from, to)
  );

  for (const row of data) {
    byWhale.set(row.whale_address, [...(byWhale.get(row.whale_address) ?? []), row]);
  }
  return byWhale;
}

/**
 * Transaction velocity from the funding-graph cache.
 *
 * Optional by design — the table may not exist, and a missing bot signal is a
 * weaker classification, not a broken page.
 */
async function fetchVelocity(addresses: string[]): Promise<Map<string, number>> {
  const velocity = new Map<string, number>();
  try {
    const data = await selectAllPages<{ address: string; tx_per_hour: number | null }>(
      'fetchVelocity',
      (from, to) =>
        db().from('wallet_traces').select('address, tx_per_hour').in('address', addresses).range(from, to)
    );
    for (const row of data) {
      if (row.tx_per_hour !== null) velocity.set(row.address as string, Number(row.tx_per_hour));
    }
  } catch {
    /* no trace cache: bot detection falls back to trade count alone */
  }
  return velocity;
}

async function fetchSnipeCounts(addresses: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const data = await selectAllPages<{ whale_address: string }>('fetchSnipeCounts', (from, to) =>
    db()
      .from('alerts')
      .select('whale_address')
      .eq('type', 'pumpfun_snipe')
      .in('whale_address', addresses)
      .range(from, to)
  );

  for (const row of data) {
    const address = row.whale_address as string;
    counts.set(address, (counts.get(address) ?? 0) + 1);
  }
  return counts;
}

async function fetchPrices(): Promise<Map<string, number | null>> {
  const prices = new Map<string, number | null>();
  const data = await selectAllPages<{ mint: string; price_usd: number | null }>(
    'fetchPrices',
    (from, to) => db().from('meme_tokens').select('mint, price_usd').range(from, to)
  );
  for (const row of data) {
    prices.set(row.mint as string, row.price_usd === null ? null : Number(row.price_usd));
  }
  return prices;
}

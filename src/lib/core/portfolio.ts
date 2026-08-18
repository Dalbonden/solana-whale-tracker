/**
 * Portfolio snapshots and rescoring.
 *
 * Run periodically. Each pass values a whale's holdings, writes one snapshot
 * row per position, and folds the fresh numbers back into the whale's score —
 * so a wallet that stops trading or rotates entirely out of memes drifts down
 * the leaderboard on its own rather than sitting there stale.
 */

import { getWhaleActivityStats, insertPortfolioSnapshot, upsertWhales } from '@/lib/db/repositories';
import { mapWithConcurrency } from '@/lib/providers/http';
import type { PortfolioHolding, Whale } from '@/types';

import { collectPortfolioMetrics, scoreWallet } from './whale-detection';

export interface SnapshotResult {
  address: string;
  holdings: number;
  totalUsd: number;
  memeUsd: number;
  score: number;
}

/**
 * Priced holdings below this are noise — dust, airdrops, rug remnants.
 * Applied ONLY to holdings we could price: a position with no price source is
 * kept regardless, because "we could not value it" is not the same claim as
 * "it is worth less than $25".
 */
const MIN_HOLDING_USD = 25;

/**
 * Cap on unpriced positions retained per snapshot, largest balance first.
 * Whale wallets accumulate long tails of spam airdrops; keeping every one would
 * bloat the table without telling anyone anything.
 */
const MAX_UNPRICED_HOLDINGS = 60;

/**
 * Days a wallet must be tracked before our own trade history is treated as a
 * complete picture of its 30-day activity rather than a partial sample.
 */
const HISTORY_MATURITY_DAYS = 7;

export async function snapshotWhale(whale: Whale): Promise<SnapshotResult> {
  const snapshotAt = new Date().toISOString();
  const portfolio = await collectPortfolioMetrics(whale.address);

  // Priced positions worth keeping...
  const priced = portfolio.holdings.filter(
    (holding) => !holding.unpriced && holding.usdValue >= MIN_HOLDING_USD
  );

  // ...plus the wallet's unpriced inventory, biggest balances first. These are
  // real holdings; they simply have no price feed, so they carry a null price
  // and contribute nothing to portfolio value.
  const unpriced = portfolio.holdings
    .filter((holding) => holding.unpriced && holding.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_UNPRICED_HOLDINGS);

  const rows: Partial<PortfolioHolding>[] = [...priced, ...unpriced].map((holding) => ({
    whale_address: whale.address,
    token_mint: holding.mint,
    token_symbol: holding.symbol,
    amount: holding.amount,
    usd_value: Number(holding.usdValue.toFixed(2)),
    price_usd: holding.priceUsd,
    pct_of_portfolio:
      portfolio.totalUsd > 0 ? Number((holding.usdValue / portfolio.totalUsd).toFixed(4)) : 0,
    is_meme: holding.isMeme,
    snapshot_at: snapshotAt,
  }));

  await insertPortfolioSnapshot(rows);

  const stats = await getWhaleActivityStats(whale.address);

  /*
   * Our trade history begins when tracking begins, so for a recently
   * discovered wallet it is not "trades in the last 30 days" — it is "trades
   * since we started watching", which is a far smaller number.
   *
   * Rescoring naively on that collapses every fresh whale to shrimp minutes
   * after discovery: a wallet with 1,494 real trades gets rescored on the 2 we
   * happened to capture. So until we have watched a wallet long enough for our
   * own history to be representative, we never let a rescore report LESS
   * activity than is already on record.
   *
   * After that point our observations are authoritative and activity is allowed
   * to decay, which is what makes a wallet that stops trading drift down the
   * leaderboard on its own.
   */
  const trackedMs = Date.now() - new Date(whale.first_seen_at ?? Date.now()).getTime();
  const historyIsRepresentative = trackedMs >= HISTORY_MATURITY_DAYS * 24 * 3600 * 1000;

  const keepHigher = (observed: number, recorded: number | null | undefined) =>
    historyIsRepresentative ? observed : Math.max(observed, recorded ?? 0);

  const tradeCount30d = keepHigher(stats.tradeCount, whale.trade_count_30d);
  const avgTradeSizeUsd = keepHigher(stats.avgUsd, whale.avg_trade_size_usd);
  const maxTradeSizeUsd = keepHigher(stats.maxUsd, whale.max_trade_size_usd);
  const distinctTokens30d = keepHigher(stats.distinctTokens, whale.distinct_tokens_30d);

  const score = scoreWallet({
    address: whale.address,
    portfolioValueUsd: portfolio.totalUsd,
    memeValueUsd: portfolio.memeUsd,
    memeExposurePct: portfolio.totalUsd > 0 ? portfolio.memeUsd / portfolio.totalUsd : 0,
    tradeCount30d,
    avgTradeSizeUsd,
    maxTradeSizeUsd,
    distinctTokens30d,
    realizedPnlUsd: whale.realized_pnl_usd ?? 0,
    winRate: null,
    lastActiveAt: stats.lastActiveAt,
  });

  await upsertWhales([
    {
      address: whale.address,
      portfolio_value_usd: Number(portfolio.totalUsd.toFixed(2)),
      meme_value_usd: Number(portfolio.memeUsd.toFixed(2)),
      meme_exposure_pct:
        portfolio.totalUsd > 0 ? Number((portfolio.memeUsd / portfolio.totalUsd).toFixed(4)) : 0,
      trade_count_30d: tradeCount30d,
      avg_trade_size_usd: Number(avgTradeSizeUsd.toFixed(2)),
      max_trade_size_usd: Number(maxTradeSizeUsd.toFixed(2)),
      distinct_tokens_30d: distinctTokens30d,
      score: score.score,
      tier: score.tier,
      last_active_at: stats.lastActiveAt?.toISOString() ?? whale.last_active_at,
    },
  ]);

  return {
    address: whale.address,
    holdings: rows.length,
    totalUsd: portfolio.totalUsd,
    memeUsd: portfolio.memeUsd,
    score: score.score,
  };
}

export async function snapshotWhales(whales: Whale[]): Promise<{
  results: SnapshotResult[];
  errors: Array<{ address: string; error: string }>;
}> {
  const results: SnapshotResult[] = [];
  const errors: Array<{ address: string; error: string }> = [];

  await mapWithConcurrency(whales, 3, async (whale) => {
    try {
      results.push(await snapshotWhale(whale));
    } catch (error) {
      errors.push({ address: whale.address, error: (error as Error).message });
    }
  });

  return { results, errors };
}

/**
 * Turns two snapshots into a human-readable diff: what was added, exited, or
 * meaningfully resized. Drives the "portfolio changes" panel.
 */
export interface HoldingChange {
  mint: string;
  symbol: string | null;
  changeType: 'opened' | 'closed' | 'increased' | 'decreased';
  previousUsd: number;
  currentUsd: number;
  deltaUsd: number;
  deltaPct: number | null;
}

export function diffSnapshots(
  previous: PortfolioHolding[],
  current: PortfolioHolding[],
  minDeltaPct = 0.1
): HoldingChange[] {
  const before = new Map(previous.map((holding) => [holding.token_mint, holding]));
  const after = new Map(current.map((holding) => [holding.token_mint, holding]));
  const changes: HoldingChange[] = [];

  for (const [mint, holding] of after) {
    const prior = before.get(mint);
    if (!prior) {
      changes.push({
        mint,
        symbol: holding.token_symbol,
        changeType: 'opened',
        previousUsd: 0,
        currentUsd: holding.usd_value,
        deltaUsd: holding.usd_value,
        deltaPct: null,
      });
      continue;
    }

    // Compare token amounts, not USD: a position can double in dollar terms
    // purely from price, which is not a portfolio change.
    if (prior.amount <= 0) continue;
    const deltaPct = (holding.amount - prior.amount) / prior.amount;
    if (Math.abs(deltaPct) < minDeltaPct) continue;

    changes.push({
      mint,
      symbol: holding.token_symbol,
      changeType: deltaPct > 0 ? 'increased' : 'decreased',
      previousUsd: prior.usd_value,
      currentUsd: holding.usd_value,
      deltaUsd: holding.usd_value - prior.usd_value,
      deltaPct,
    });
  }

  for (const [mint, prior] of before) {
    if (after.has(mint)) continue;
    changes.push({
      mint,
      symbol: prior.token_symbol,
      changeType: 'closed',
      previousUsd: prior.usd_value,
      currentUsd: 0,
      deltaUsd: -prior.usd_value,
      deltaPct: -1,
    });
  }

  return changes.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
}

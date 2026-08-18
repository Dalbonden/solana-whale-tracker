/**
 * Alert generation.
 *
 * Alerts are derived from newly-inserted trades only (see
 * `insertTrades`, which returns just the rows that were genuinely new), so a
 * replayed webhook or an overlapping cron sync cannot double-fire. The database
 * carries a second guard: a partial unique index on
 * (type, whale, token, signature).
 *
 * Signal design — what is actually worth waking someone up for:
 *
 *   new_position   a whale opens a name it has never held. The earliest read on
 *                  conviction, and the highest-signal alert in the set.
 *   cluster_buy    N independent whales buy the same token inside one window.
 *                  This is the rotation signal: one whale is an opinion, three
 *                  is a trend.
 *   rotation       a whale fully exits one name and opens another shortly
 *                  after — capital moving, not just risk coming off.
 *   pumpfun_snipe  a buy within minutes of launch. Pure alpha or pure exit
 *                  liquidity; either way you want to know.
 *   full_exit      the position is closed. Often the top.
 *   large_buy /
 *   large_sell     size thresholds, for everything the above does not catch.
 */

import { config } from '@/lib/config';
import {
  countDistinctBuyers,
  getPositionHistory,
  getRecentExits,
  insertAlerts,
} from '@/lib/db/repositories';
import * as pumpfun from '@/lib/providers/pumpfun';
import { EXPLORERS, looksLikePumpfunMint } from '@/lib/solana/constants';
import type { Alert, AlertSeverity, AlertType, WhaleTrade } from '@/types';

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

interface DraftAlert {
  type: AlertType;
  severity: AlertSeverity;
  whale_address: string | null;
  token_mint: string | null;
  token_symbol: string | null;
  title: string;
  message: string;
  usd_value: number | null;
  signature: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Evaluates one trade against every rule. Rules are independent — a single
 * trade can legitimately produce a `new_position`, a `large_buy` and a
 * `cluster_buy`.
 */
export async function evaluateTrade(trade: WhaleTrade): Promise<DraftAlert[]> {
  const drafts: DraftAlert[] = [];
  const symbol = trade.token_symbol || trade.token_mint.slice(0, 6);
  const who = trade.whale_address;
  const base = {
    whale_address: who,
    token_mint: trade.token_mint,
    token_symbol: trade.token_symbol,
    signature: trade.signature,
    usd_value: trade.usd_value,
  };

  const links = {
    tx: EXPLORERS.tx(trade.signature),
    wallet: EXPLORERS.account(who),
    token: EXPLORERS.birdeye(trade.token_mint),
  };

  // --- new position --------------------------------------------------------
  if (trade.side === 'buy' && trade.is_new_position) {
    drafts.push({
      ...base,
      type: 'new_position',
      severity: trade.usd_value >= config.alerts.largeTradeUsd ? 'critical' : 'warning',
      title: `${shortAddress(who)} opened ${symbol}`,
      message: `New position: bought ${usd(trade.usd_value)} of ${symbol} on ${trade.venue}. No prior recorded holding.`,
      metadata: { venue: trade.venue, tokenAmount: trade.token_amount, links },
    });
  }

  // --- full exit -----------------------------------------------------------
  if (trade.side === 'sell' && trade.is_full_exit) {
    drafts.push({
      ...base,
      type: 'full_exit',
      severity: trade.usd_value >= config.alerts.largeTradeUsd ? 'critical' : 'warning',
      title: `${shortAddress(who)} exited ${symbol}`,
      message: `Closed position: sold ${usd(trade.usd_value)} of ${symbol} on ${trade.venue}, leaving no meaningful balance.`,
      metadata: { venue: trade.venue, tokenAmount: trade.token_amount, links },
    });
  }

  // --- size thresholds -----------------------------------------------------
  if (trade.usd_value >= config.alerts.largeTradeUsd) {
    const isBuy = trade.side === 'buy';
    drafts.push({
      ...base,
      type: isBuy ? 'large_buy' : 'large_sell',
      severity: trade.usd_value >= config.alerts.largeTradeUsd * 5 ? 'critical' : 'info',
      title: `${usd(trade.usd_value)} ${isBuy ? 'buy' : 'sell'} — ${symbol}`,
      message: `${shortAddress(who)} ${isBuy ? 'bought' : 'sold'} ${usd(trade.usd_value)} of ${symbol} on ${trade.venue}.`,
      metadata: { venue: trade.venue, tokenAmount: trade.token_amount, links },
    });
  }

  // --- pump.fun snipe ------------------------------------------------------
  if (trade.side === 'buy' && (trade.venue === 'pumpfun' || looksLikePumpfunMint(trade.token_mint))) {
    const launchedAt = await pumpfun.getLaunchTime(trade.token_mint);
    if (launchedAt) {
      const minutesSinceLaunch =
        (new Date(trade.block_time).getTime() - launchedAt.getTime()) / 60_000;
      if (minutesSinceLaunch >= 0 && minutesSinceLaunch <= config.alerts.snipeWindowMinutes) {
        drafts.push({
          ...base,
          type: 'pumpfun_snipe',
          severity: 'critical',
          title: `Snipe: ${symbol} ${minutesSinceLaunch.toFixed(0)}m after launch`,
          message: `${shortAddress(who)} bought ${usd(trade.usd_value)} of ${symbol} ${minutesSinceLaunch.toFixed(0)} minutes after it launched on pump.fun.`,
          metadata: {
            venue: trade.venue,
            minutesSinceLaunch: Number(minutesSinceLaunch.toFixed(1)),
            launchedAt: launchedAt.toISOString(),
            links: { ...links, pumpfun: EXPLORERS.pumpfun(trade.token_mint) },
          },
        });
      }
    }
  }

  // --- rotation ------------------------------------------------------------
  if (trade.side === 'buy' && trade.is_new_position) {
    const exits = await getRecentExits(who, config.alerts.rotationWindowMinutes);
    const priorExit = exits.find((exit) => exit.token_mint !== trade.token_mint);
    if (priorExit) {
      const fromSymbol = priorExit.token_symbol || priorExit.token_mint.slice(0, 6);
      drafts.push({
        ...base,
        type: 'rotation',
        severity: 'critical',
        title: `Rotation: ${fromSymbol} → ${symbol}`,
        message: `${shortAddress(who)} exited ${fromSymbol} and opened ${usd(trade.usd_value)} of ${symbol} within ${config.alerts.rotationWindowMinutes} minutes.`,
        metadata: {
          fromMint: priorExit.token_mint,
          fromSymbol,
          exitedAt: priorExit.block_time,
          links,
        },
      });
    }
  }

  // --- cluster buy ---------------------------------------------------------
  if (trade.side === 'buy') {
    const buyers = await countDistinctBuyers(trade.token_mint, config.alerts.clusterWindowMinutes);
    if (buyers.length >= config.alerts.clusterWhales) {
      drafts.push({
        ...base,
        type: 'cluster_buy',
        severity: 'critical',
        // Signature is the cluster's trigger trade, which keeps the dedupe
        // index from firing this once per participating whale.
        title: `${buyers.length} whales accumulating ${symbol}`,
        message: `${buyers.length} tracked whales bought ${symbol} in the last ${config.alerts.clusterWindowMinutes} minutes. Possible rotation into the name.`,
        metadata: { buyers, windowMinutes: config.alerts.clusterWindowMinutes, links },
      });
    }
  }

  return drafts;
}

/**
 * Runs the rules over a batch of new trades and persists the results.
 *
 * Cluster alerts are collapsed to one per token per batch — without that, a
 * burst of five whale buys in the same block would write five near-identical
 * "whales accumulating" rows.
 */
export async function generateAlerts(trades: WhaleTrade[]): Promise<Alert[]> {
  if (!trades.length) return [];

  const drafts: DraftAlert[] = [];
  for (const trade of trades) {
    try {
      drafts.push(...(await evaluateTrade(trade)));
    } catch (error) {
      console.error(`[alerts] evaluate failed for ${trade.signature}:`, (error as Error).message);
    }
  }

  const seenClusters = new Set<string>();
  const deduped = drafts.filter((draft) => {
    if (draft.type !== 'cluster_buy') return true;
    const key = draft.token_mint ?? '';
    if (seenClusters.has(key)) return false;
    seenClusters.add(key);
    return true;
  });

  if (!deduped.length) return [];
  return insertAlerts(deduped);
}

/** Announces a newly discovered whale. */
export async function alertWhaleDiscovered(
  address: string,
  score: number,
  tier: string,
  portfolioUsd: number
): Promise<void> {
  await insertAlerts([
    {
      type: 'whale_discovered',
      severity: 'info',
      whale_address: address,
      token_mint: null,
      token_symbol: null,
      title: `New ${tier} tracked: ${shortAddress(address)}`,
      message: `Added ${shortAddress(address)} — score ${score.toFixed(1)}, portfolio ${usd(portfolioUsd)}.`,
      usd_value: portfolioUsd,
      // Discovery has no transaction; the dedupe index only covers rows with a
      // signature, so re-discovery is guarded by the whales table instead.
      signature: null,
      metadata: { score, tier, links: { wallet: EXPLORERS.account(address) } },
    },
  ]);
}

/**
 * Classifies a trade against the whale's stored position, producing the
 * `is_new_position` / `is_full_exit` flags the rules above depend on.
 */
export interface PositionClassification {
  isNewPosition: boolean;
  isFullExit: boolean;
  /** Average USD cost of the tokens being sold. Null when never observed. */
  costBasisUsd: number | null;
  /** Profit or loss on this sell in USD. Null for buys, or basis unknown. */
  realizedPnlUsd: number | null;
  /** Same as a fraction of cost, e.g. 0.42 = +42%. */
  realizedPnlPct: number | null;
}

/**
 * Classifies a trade against the whale's observed position and, for sells,
 * scores the profit or loss.
 *
 * P&L uses an average cost basis over the buys we have actually recorded. Our
 * history begins when tracking begins, so a wallet that bought before then has
 * no knowable basis — those sells return null rather than a fabricated figure.
 * Showing "+$40,000 profit" for a position whose entry we never saw would be
 * pure invention, and a P&L column nobody can trust is worse than none.
 */
export async function classifyPosition(
  whale: string,
  mint: string,
  side: 'buy' | 'sell',
  tokenAmount: number,
  usdValue = 0
): Promise<PositionClassification> {
  const history = await getPositionHistory(whale, mint);
  const heldBefore = history.boughtAmount - history.soldAmount;

  if (side === 'buy') {
    const isNewPosition = history.tradeCount === 0 || heldBefore <= 0;
    return {
      isNewPosition,
      isFullExit: false,
      costBasisUsd: null,
      realizedPnlUsd: null,
      realizedPnlPct: null,
    };
  }

  // --- sell ---------------------------------------------------------------
  const avgCost = history.avgCostUsd;

  // Only score the portion we can actually attribute to observed buys. Selling
  // more than we ever saw bought means the rest came from an unseen entry.
  const attributable = avgCost !== null ? Math.min(tokenAmount, Math.max(heldBefore, 0)) : 0;

  let costBasisUsd: number | null = null;
  let realizedPnlUsd: number | null = null;
  let realizedPnlPct: number | null = null;

  if (avgCost !== null && attributable > 0 && usdValue > 0) {
    // Proceeds for the attributable share of the sale.
    const proceeds = usdValue * (attributable / tokenAmount);
    costBasisUsd = avgCost * attributable;
    realizedPnlUsd = proceeds - costBasisUsd;
    realizedPnlPct = costBasisUsd > 0 ? realizedPnlUsd / costBasisUsd : null;
  }

  if (heldBefore <= 0) {
    // Never saw them buy it: cannot claim this closed the position.
    return { isNewPosition: false, isFullExit: false, costBasisUsd, realizedPnlUsd, realizedPnlPct };
  }

  const remaining = heldBefore - tokenAmount;
  const isFullExit = remaining / heldBefore <= config.alerts.fullExitResidual;
  return { isNewPosition: false, isFullExit, costBasisUsd, realizedPnlUsd, realizedPnlPct };
}

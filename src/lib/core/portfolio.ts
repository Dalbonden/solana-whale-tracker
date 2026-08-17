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

/** Holdings below this are noise — dust, airdrops, worthless rug remnants. */
const MIN_HOLDING_USD = 25;

export async function snapshotWhale(whale: Whale): Promise<SnapshotResult> {
  const snapshotAt = new Date().toISOString();
  const portfolio = await collectPortfolioMetrics(whale.address);

  const significant = portfolio.holdings.filter((holding) => holding.usdValue >= MIN_HOLDING_USD);

  const rows: Partial<PortfolioHolding>[] = significant.map((holding) => ({
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

  // Rescore with the fresh portfolio plus stored 30-day activity.
  const stats = await getWhaleActivityStats(whale.address);
  const score = scoreWallet({
    address: whale.address,
    portfolioValueUsd: portfolio.totalUsd,
    memeValueUsd: portfolio.memeUsd,
    memeExposurePct: portfolio.totalUsd > 0 ? portfolio.memeUsd / portfolio.totalUsd : 0,
    tradeCount30d: stats.tradeCount,
    avgTradeSizeUsd: stats.avgUsd,
    maxTradeSizeUsd: stats.maxUsd,
    distinctTokens30d: stats.distinctTokens,
    realizedPnlUsd: 0,
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
      trade_count_30d: stats.tradeCount,
      avg_trade_size_usd: Number(stats.avgUsd.toFixed(2)),
      max_trade_size_usd: Number(stats.maxUsd.toFixed(2)),
      distinct_tokens_30d: stats.distinctTokens,
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

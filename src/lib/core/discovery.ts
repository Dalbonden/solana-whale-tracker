/**
 * Whale discovery orchestration.
 *
 * Sources candidate wallets from the tracked meme universe, evaluates each one
 * against the detection thresholds, and persists the wallets that qualify.
 *
 * Discovery is the most expensive job in the system — every candidate costs at
 * least one portfolio lookup — so it is bounded on both ends: candidates are
 * capped per run, and wallets already tracked are skipped entirely.
 */

import { config } from '@/lib/config';
import { getKnownWhaleAddresses, listTokens, upsertWhales } from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import * as helius from '@/lib/providers/helius';
import { mapWithConcurrency } from '@/lib/providers/http';
import type { Whale } from '@/types';

import { alertWhaleDiscovered } from './alerts';
import { evaluateWallet, gatherCandidates, type Candidate } from './whale-detection';

export interface DiscoveryResult {
  candidates: number;
  /** Candidates sourced from the realised-profit leaderboard. */
  profitableSeeds: number;
  /** Profit-seeded wallets dropped for holding nothing. */
  emptyShellsSkipped: number;
  evaluated: number;
  qualified: number;
  added: Array<{ address: string; score: number; tier: string; portfolioUsd: number }>;
  rejected: Array<{ address: string; reason: string }>;
  errors: Array<{ address: string; error: string }>;
}

/**
 * Runs one discovery pass.
 *
 * @param opts.mints        restrict discovery to these tokens; defaults to the
 *                          highest-volume tracked tokens
 * @param opts.maxCandidates hard cap on wallets evaluated this run
 * @param opts.includeKnown  re-evaluate wallets we already track (used by the
 *                           rescore path, not by routine discovery)
 */
export async function runDiscovery(
  opts: { mints?: string[]; maxCandidates?: number; includeKnown?: boolean } = {}
): Promise<DiscoveryResult> {
  const maxCandidates = opts.maxCandidates ?? config.limits.discoveryCandidates;

  let mints = opts.mints;
  if (!mints?.length) {
    // Highest-volume tokens first: that is where active whales actually are.
    const tokens = await listTokens({ activeOnly: true, limit: 25 });
    mints = tokens.map((token) => token.mint);
  }

  if (!mints.length) {
    return {
      candidates: 0,
      profitableSeeds: 0,
      emptyShellsSkipped: 0,
      evaluated: 0,
      qualified: 0,
      added: [],
      rejected: [],
      errors: [],
    };
  }

  const candidates = await gatherCandidates(mints, { perToken: 10, includeHolders: true });

  /*
   * Second seed: wallets ranked by profit actually realised.
   *
   * Token-level top-trader lists are sorted by volume, and volume selects for
   * churn — which is how the roster ended up dominated by wallets that trade
   * enormously and lose steadily. This source asks a different question: who
   * has taken money off the table. Several windows are sampled because a single
   * day rewards one good trade, while a month favours wallets that keep doing
   * it.
   */
  const profitable: Candidate[] = [];
  for (const window of ['today', '1W', '30d'] as const) {
    const traders = await birdeye
      .getProfitableTraders({ window, limit: 100, minRealizedUsd: 10_000, minTrades: 10 })
      .catch(() => []);

    for (const trader of traders) {
      profitable.push({
        address: trader.address,
        source: 'birdeye_gainers',
        tradeCount: trader.tradeCount,
        volumeUsd: trader.volumeUsd,
        avgTradeUsd: trader.tradeCount > 0 ? trader.volumeUsd / trader.tradeCount : undefined,
        realizedPnlUsd: trader.realizedPnlUsd,
      });
    }
  }

  /*
   * Drop the throwaways before spending a full evaluation on them.
   *
   * A realised-profit leaderboard measures throughput, not wealth. Checked
   * against chain state, the top wallets by realised P&L hold *nothing*: one
   * had banked $121,739 across 495 trades and finished with 0 SOL and zero
   * token accounts. They are trading legs that get swept out, not people
   * accumulating anything.
   *
   * The portfolio floor already rejects them, but only after a full portfolio
   * valuation each — 200 shells consumed an entire discovery run and crowded
   * out real candidates. One balance lookup costs a fraction of that and
   * removes them up front. A wallet holding $50k of anything keeps SOL for
   * fees, so an empty native balance is conclusive.
   */
  const SHELL_SOL_FLOOR = 0.05;
  const withBalance: Candidate[] = [];
  await mapWithConcurrency(profitable, 8, async (candidate) => {
    const sol = await helius.getSolBalance(candidate.address).catch(() => null);
    // A failed lookup keeps the candidate: missing evidence is not evidence.
    if (sol === null || sol >= SHELL_SOL_FLOOR) withBalance.push(candidate);
  });
  const shellsSkipped = profitable.length - withBalance.length;

  // Best realised figure wins when a wallet appears in more than one window.
  const merged = new Map<string, Candidate>();
  for (const candidate of [...candidates, ...withBalance]) {
    const existing = merged.get(candidate.address);
    if (!existing) {
      merged.set(candidate.address, candidate);
      continue;
    }
    merged.set(candidate.address, {
      ...existing,
      ...candidate,
      realizedPnlUsd: Math.max(existing.realizedPnlUsd ?? 0, candidate.realizedPnlUsd ?? 0),
      volumeUsd: Math.max(existing.volumeUsd ?? 0, candidate.volumeUsd ?? 0),
    });
  }
  const allCandidates = [...merged.values()];

  const known = opts.includeKnown ? new Set<string>() : await getKnownWhaleAddresses();
  const queue = allCandidates
    .filter((candidate) => !known.has(candidate.address))
    /*
     * Profit first, volume second. A truncated run should surface the wallets
     * that make money rather than the ones that move the most size, and those
     * are rarely the same list — ranking by volume is what filled the roster
     * with high-turnover losers in the first place.
     */
    .sort((a, b) => {
      const profit = (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0);
      if (profit !== 0) return profit;
      return (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0);
    })
    .slice(0, maxCandidates);

  const added: DiscoveryResult['added'] = [];
  const rejected: DiscoveryResult['rejected'] = [];
  const errors: DiscoveryResult['errors'] = [];
  const qualifying: Partial<Whale>[] = [];

  await mapWithConcurrency(queue, 4, async (candidate: Candidate) => {
    try {
      const evaluation = await evaluateWallet(candidate.address, {
        tradeCount: candidate.tradeCount,
        volumeUsd: candidate.volumeUsd,
        avgTradeUsd: candidate.avgTradeUsd,
        realizedPnlUsd: candidate.realizedPnlUsd,
        source: candidate.source,
      });

      if (!evaluation.whale) {
        rejected.push({
          address: candidate.address,
          reason: evaluation.rejected ?? 'did not qualify',
        });
        return;
      }

      qualifying.push(evaluation.whale);
      added.push({
        address: candidate.address,
        score: evaluation.score.score,
        tier: evaluation.score.tier,
        portfolioUsd: evaluation.metrics.portfolioValueUsd,
      });
    } catch (error) {
      errors.push({ address: candidate.address, error: (error as Error).message });
    }
  });

  if (qualifying.length) {
    await upsertWhales(qualifying);
    // Announce discoveries so the activity feed shows the roster growing.
    for (const entry of added) {
      await alertWhaleDiscovered(entry.address, entry.score, entry.tier, entry.portfolioUsd).catch(
        () => undefined
      );
    }
  }

  return {
    candidates: allCandidates.length,
    profitableSeeds: profitable.length,
    emptyShellsSkipped: shellsSkipped,
    evaluated: queue.length,
    qualified: qualifying.length,
    added,
    rejected: rejected.slice(0, 50),
    errors,
  };
}

/**
 * Re-evaluates wallets already tracked and untracks the ones that no longer
 * qualify. Without this the whale list only ever grows.
 */
export async function pruneInactiveWhales(
  whales: Whale[],
  inactiveDays = 45
): Promise<{ untracked: string[] }> {
  const cutoff = Date.now() - inactiveDays * 24 * 3600 * 1000;
  const untracked: string[] = [];
  const updates: Partial<Whale>[] = [];

  for (const whale of whales) {
    const lastActive = whale.last_active_at ? new Date(whale.last_active_at).getTime() : 0;
    const dormant = lastActive > 0 && lastActive < cutoff;
    const belowFloor = whale.portfolio_value_usd < config.detection.minPortfolioUsd * 0.5;

    if (dormant || belowFloor) {
      updates.push({ address: whale.address, is_tracked: false });
      untracked.push(whale.address);
    }
  }

  if (updates.length) await upsertWhales(updates);
  return { untracked };
}

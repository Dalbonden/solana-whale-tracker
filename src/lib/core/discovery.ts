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
import { mapWithConcurrency } from '@/lib/providers/http';
import type { Whale } from '@/types';

import { alertWhaleDiscovered } from './alerts';
import { evaluateWallet, gatherCandidates, type Candidate } from './whale-detection';

export interface DiscoveryResult {
  candidates: number;
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
    return { candidates: 0, evaluated: 0, qualified: 0, added: [], rejected: [], errors: [] };
  }

  const candidates = await gatherCandidates(mints, { perToken: 10, includeHolders: true });

  const known = opts.includeKnown ? new Set<string>() : await getKnownWhaleAddresses();
  const queue = candidates
    .filter((candidate) => !known.has(candidate.address))
    // Evaluate the highest-volume candidates first so a truncated run still
    // surfaces the most interesting wallets.
    .sort((a, b) => (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0))
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
    candidates: candidates.length,
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

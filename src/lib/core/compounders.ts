/**
 * The compounders board: which tracked wallets are actually getting richer.
 *
 * Combines two independent readings, because neither alone is trustworthy:
 *
 *   Trading P&L    realised + unrealised from our own position ledger. Available
 *                  immediately, and attributable — it is money made by trading.
 *                  Blind to anything held outside the tracked meme universe.
 *
 *   Net worth      the balance curve from `whale_portfolios` snapshots. Covers
 *                  the whole book, but includes deposits and market beta, and
 *                  needs history this app has to accumulate itself.
 *
 * Read together they check each other: a balance that grew far beyond what
 * trading explains is a transfer, not skill, and the row says so.
 */

import { getPortfolioTimelines, listPositions } from '@/lib/db/repositories';
import type { Whale } from '@/types';

import { derivePositionView } from './positions';
import {
  attributionNote,
  classifyWealth,
  computeTrajectory,
  medianOf,
  relativeGrowth,
  type Trajectory,
  type WealthVerdict,
} from './wealth';

export interface CompounderRow {
  address: string;
  label: string | null;
  tier: string;
  portfolioUsd: number;

  /** Realised + unrealised on positions whose entry we observed. */
  tradingPnlUsd: number | null;
  realisedUsd: number;
  unrealisedUsd: number | null;
  /** Open cycles we could not mark, so the P&L above is partial. */
  unmarkedPositions: number;

  /** Share of the wallet's portfolio our position ledger actually covers. */
  coverage: number | null;

  trajectory: Trajectory;
  verdict: WealthVerdict;
  /** Growth over the cohort median, in percentage points. */
  relativeGrowthPp: number | null;
  attribution: string | null;
}

export interface CompoundersBoard {
  rows: CompounderRow[];
  cohortMedianPct: number | null;
  /** Wallets with enough snapshot history for a verdict. */
  measurable: number;
  /** Distinct snapshot times available, across the roster. */
  snapshotDepth: number;
  windowDays: number;
}

export async function buildCompoundersBoard(
  whales: Whale[],
  opts: { days?: number; prices?: Map<string, number | null> } = {}
): Promise<CompoundersBoard> {
  const windowDays = opts.days ?? 30;
  const addresses = whales.map((w) => w.address);

  const timelines = await getPortfolioTimelines(addresses, windowDays);

  // Trajectories first, so the cohort median exists before anything is judged
  // against it.
  const trajectories = new Map<string, Trajectory>();
  for (const whale of whales) {
    trajectories.set(whale.address, computeTrajectory(timelines.get(whale.address) ?? []));
  }

  const cohortMedianPct = medianOf(
    [...trajectories.values()].filter((t) => t.sufficient).map((t) => t.changePct)
  );

  const rows: CompounderRow[] = [];

  for (const whale of whales) {
    const positions = await listPositions(whale.address).catch(() => []);

    let realised = 0;
    let unrealised = 0;
    let unmarked = 0;
    let anyMark = false;
    let trackedValue = 0;

    for (const position of positions) {
      realised += Number(position.realized_pnl_usd) || 0;

      if (position.status !== 'open') continue;
      const price = opts.prices?.get(position.token_mint) ?? null;
      const view = derivePositionView(position, price, whale.portfolio_value_usd);
      trackedValue += view.market_value_usd ?? 0;
      if (view.unrealized_pnl_usd === null) {
        unmarked += 1;
      } else {
        unrealised += view.unrealized_pnl_usd;
        anyMark = true;
      }
    }

    const trajectory = trajectories.get(whale.address)!;
    const tradingPnl = anyMark || realised !== 0 ? realised + unrealised : null;

    /*
     * How much of this wallet we can actually see. Our ledger holds observed
     * meme positions only, so on a large book mostly held in other assets the
     * trading figure is a rounding error against the balance curve — and
     * comparing them would produce a confident story about deposits from
     * essentially no evidence.
     */
    const coverage =
      whale.portfolio_value_usd > 0 ? trackedValue / whale.portfolio_value_usd : null;

    rows.push({
      address: whale.address,
      label: whale.label,
      tier: whale.tier,
      portfolioUsd: whale.portfolio_value_usd,
      coverage,
      tradingPnlUsd: tradingPnl,
      realisedUsd: realised,
      unrealisedUsd: anyMark ? unrealised : null,
      unmarkedPositions: unmarked,
      trajectory,
      verdict: classifyWealth(trajectory, cohortMedianPct),
      relativeGrowthPp: relativeGrowth(trajectory.changePct, cohortMedianPct),
      /*
       * Only explain a move once the trajectory is trustworthy. Two snapshots
       * an hour apart produce a balance delta, and comparing that to trading
       * P&L was labelling wallets "transfers, not performance" from data the
       * same row admits is insufficient — a conclusion drawn from evidence
       * already declared unusable.
       */
      attribution: trajectory.sufficient
        ? attributionNote(trajectory.changeUsd, tradingPnl, coverage)
        : null,
    });
  }

  /*
   * Ranked by whichever evidence exists. Once snapshot history is deep enough,
   * relative growth leads — it is the metric that cannot be bought by simply
   * being large. Until then the board falls back to trading P&L so it is
   * useful on day one rather than empty for a week.
   */
  rows.sort((a, b) => {
    const byRelative = (b.relativeGrowthPp ?? -Infinity) - (a.relativeGrowthPp ?? -Infinity);
    if (byRelative !== 0 && Number.isFinite(byRelative)) return byRelative;
    return (b.tradingPnlUsd ?? -Infinity) - (a.tradingPnlUsd ?? -Infinity);
  });

  const snapshotDepth = new Set(
    [...timelines.values()].flatMap((points) => points.map((p) => p.at))
  ).size;

  return {
    rows,
    cohortMedianPct,
    measurable: rows.filter((r) => r.trajectory.sufficient).length,
    snapshotDepth,
    windowDays,
  };
}

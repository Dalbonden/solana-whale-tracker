/**
 * Net-worth trajectory — is this wallet compounding or bleeding?
 *
 * WHY THIS IS THE DIFFERENTIATED METRIC
 *
 * Every wallet explorer shows what an address holds *now*. That is a single
 * API call against current chain state, so everyone has it and nobody can
 * charge for it. What no stateless service can answer is whether the number is
 * going up: that needs someone to have been recording balances all along, and
 * this app does, in `whale_portfolios`.
 *
 * THREE WAYS A NAIVE VERSION LIES
 *
 * 1. Market beta. When SOL rallies 20% every portfolio grows, and reporting
 *    that as "compounding" would rank wallets by how early they were born.
 *    Growth is therefore measured against the cohort's own median over the same
 *    window — a wallet only compounds if it outgrows the wallets beside it.
 *
 * 2. Deposits. A wallet that receives $1M from an exchange shows enormous
 *    "growth" and did nothing. This cannot be fully solved without a transfer
 *    audit, so it is surfaced instead: portfolio change is reported alongside
 *    trading P&L from our own ledger, and a sharp divergence between them is
 *    flagged as probable external movement rather than skill.
 *
 * 3. Too few points. Two snapshots twelve hours apart is noise, not a
 *    trajectory. Below a floor the answer is "not enough history yet" — never a
 *    number that looks authoritative.
 *
 * Pure: no imports, no I/O. The caller supplies snapshots.
 */

export interface WealthSnapshot {
  /** Unix seconds. */
  at: number;
  totalUsd: number;
}

export type WealthVerdict = 'compounding' | 'bleeding' | 'tracking' | 'insufficient';

export interface Trajectory {
  latestUsd: number | null;
  earliestUsd: number | null;
  changeUsd: number | null;
  changePct: number | null;
  /** Hours between the first and last snapshot used. */
  spanHours: number;
  points: number;
  /** Enough history for the number to mean anything. */
  sufficient: boolean;
  /** What is still missing when it is not. */
  shortfall: string | null;
}

/** A trajectory needs at least this much history before it is reported. */
export const MIN_POINTS = 3;
export const MIN_SPAN_HOURS = 24;

/**
 * Below this share of a portfolio tracked, our trading ledger is too small a
 * sample to say anything about why the balance moved.
 */
const MIN_COVERAGE_FOR_ATTRIBUTION = 0.1;

/** Moves smaller than this are noise in either direction. */
const FLAT_BAND_PP = 2;

export function computeTrajectory(snapshots: WealthSnapshot[]): Trajectory {
  const ordered = [...snapshots].sort((a, b) => a.at - b.at);
  const points = ordered.length;

  if (points < 2) {
    return {
      latestUsd: ordered[0]?.totalUsd ?? null,
      earliestUsd: ordered[0]?.totalUsd ?? null,
      changeUsd: null,
      changePct: null,
      spanHours: 0,
      points,
      sufficient: false,
      shortfall: `only ${points} snapshot${points === 1 ? '' : 's'} recorded`,
    };
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const spanHours = (last.at - first.at) / 3600;
  const changeUsd = last.totalUsd - first.totalUsd;
  const changePct = first.totalUsd > 0 ? changeUsd / first.totalUsd : null;

  const missing: string[] = [];
  if (points < MIN_POINTS) missing.push(`${MIN_POINTS - points} more snapshot(s)`);
  if (spanHours < MIN_SPAN_HOURS) {
    missing.push(`${Math.ceil(MIN_SPAN_HOURS - spanHours)}h more history`);
  }

  return {
    latestUsd: last.totalUsd,
    earliestUsd: first.totalUsd,
    changeUsd,
    changePct,
    spanHours,
    points,
    sufficient: missing.length === 0,
    shortfall: missing.length ? `needs ${missing.join(' and ')}` : null,
  };
}

/**
 * Growth relative to the cohort, in percentage points.
 *
 * The benchmark is the median tracked wallet rather than a price index, which
 * makes it self-normalising: whatever the market did, it did to everyone here.
 */
export function relativeGrowth(
  changePct: number | null,
  cohortMedianPct: number | null
): number | null {
  if (changePct === null || cohortMedianPct === null) return null;
  return (changePct - cohortMedianPct) * 100;
}

export function classifyWealth(
  trajectory: Trajectory,
  cohortMedianPct: number | null
): WealthVerdict {
  if (!trajectory.sufficient || trajectory.changePct === null) return 'insufficient';

  const relative = relativeGrowth(trajectory.changePct, cohortMedianPct);
  // With no cohort to compare against, fall back to absolute movement and keep
  // the same dead band. It is a weaker claim, but it is the same claim shape.
  const measure = relative ?? trajectory.changePct * 100;

  if (measure > FLAT_BAND_PP) return 'compounding';
  if (measure < -FLAT_BAND_PP) return 'bleeding';
  return 'tracking';
}

/**
 * Explains — or refuses to explain — a change in balance.
 *
 * Three distinct situations, and conflating them is how this metric would most
 * easily mislead:
 *
 *   1. We barely track this wallet. Our ledger covers observed meme positions
 *      only, so on a $21M book holding mostly other assets, portfolio change
 *      and trading P&L are not comparable quantities at all. Saying "transfers"
 *      here would be a confident claim built on a rounding error — the first
 *      version of this did exactly that and flagged nearly every row.
 *   2. We track enough to compare, and trading does not account for the move:
 *      money came in or went out.
 *   3. Trading accounts for it. Nothing to say.
 *
 * `coverage` is the share of the portfolio we actually have positions for.
 */
export function attributionNote(
  changeUsd: number | null,
  tradingPnlUsd: number | null,
  coverage: number | null
): string | null {
  if (changeUsd === null) return null;

  // Case 1: too little of the book is visible for the comparison to mean
  // anything.
  if (coverage !== null && coverage < MIN_COVERAGE_FOR_ATTRIBUTION) {
    return `Only ${(coverage * 100).toFixed(1)}% of this wallet's holdings are tracked, so this change cannot be attributed to trading.`;
  }

  if (tradingPnlUsd === null) return null;

  const unexplained = changeUsd - tradingPnlUsd;
  const scale = Math.max(Math.abs(changeUsd), 1);
  if (Math.abs(unexplained) / scale < 0.5) return null;
  if (Math.abs(unexplained) < 1_000) return null;

  return unexplained > 0
    ? 'Balance grew far more than trading explains — likely deposits from elsewhere, not performance.'
    : 'Balance fell far more than trading explains — likely withdrawals, not losses.';
}

/** Median of a numeric list, ignoring nulls. Null when nothing is usable. */
export function medianOf(values: Array<number | null>): number | null {
  const usable = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!usable.length) return null;
  const sorted = usable.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

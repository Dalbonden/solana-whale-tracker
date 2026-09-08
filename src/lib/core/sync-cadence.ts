/**
 * How often each whale is worth polling.
 *
 * THE PROBLEM THIS SOLVES
 *
 * `getWhalesToSync` ordered purely by `last_synced_at`, so every tracked wallet
 * was polled on the same fixed cycle regardless of whether it had done
 * anything. A whale that last traded three weeks ago cost exactly as much to
 * follow as one trading hourly, and each poll is a Helius enhanced-history
 * request whether or not it returns a single transaction. On a free allowance
 * that is the difference between following fifteen wallets comfortably and
 * running out of credits mid-month.
 *
 * The webhook is the real-time path — this cron exists only as a backstop for
 * deliveries that were missed or never subscribed. A backstop does not need to
 * run at the same rate for a dormant wallet as for an active one, so the
 * interval is scaled by how recently the wallet actually traded.
 *
 * WHY RECENCY AND NOT SCORE
 *
 * Tempting to poll the biggest wallets most often, but size does not predict
 * activity: the largest tracked book is also one of the quietest. Recent
 * trading is the only signal that predicts more trading, so that is what sets
 * the rate. A dormant whale that wakes up is caught by its next scheduled poll
 * and then immediately promotes itself to the fast tier.
 *
 * Pure and import-free so the tiering can be tested without a database.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface CadenceTier {
  /** Applies when the wallet traded within this many ms of now. */
  activeWithinMs: number;
  everyMinutes: number;
  label: string;
}

/**
 * Ordered most-active first; the first match wins.
 *
 * The slowest tier is deliberately not "never". A wallet with no recorded
 * activity may simply predate the tracker's history, and a twelve-hourly poll
 * is cheap enough to keep it honest.
 */
export const CADENCE_TIERS: readonly CadenceTier[] = [
  { activeWithinMs: 6 * HOUR, everyMinutes: 15, label: 'hot' },
  { activeWithinMs: 48 * HOUR, everyMinutes: 60, label: 'active' },
  { activeWithinMs: 7 * 24 * HOUR, everyMinutes: 240, label: 'slow' },
  { activeWithinMs: Number.POSITIVE_INFINITY, everyMinutes: 720, label: 'dormant' },
];

export interface SyncCandidate {
  address: string;
  /** Last time the wallet was seen trading. */
  last_active_at: string | null;
  /** Last time we polled it, successfully or not. */
  last_synced_at: string | null;
}

function toTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The tier a wallet falls into given how recently it traded. */
export function tierFor(lastActiveAt: string | null, now: number): CadenceTier {
  const active = toTime(lastActiveAt);
  // Unknown activity is treated as dormant, not as hot: guessing "poll often"
  // for every wallet with a missing timestamp is how the old behaviour is
  // reintroduced by accident.
  const age = active === null ? Number.POSITIVE_INFINITY : Math.max(0, now - active);
  return CADENCE_TIERS.find((tier) => age <= tier.activeWithinMs) ?? CADENCE_TIERS[CADENCE_TIERS.length - 1];
}

/** How long until this wallet is due, in ms. Negative means overdue. */
export function msUntilDue(whale: SyncCandidate, now: number): number {
  const synced = toTime(whale.last_synced_at);
  // Never polled is always due — a newly discovered whale must not wait.
  if (synced === null) return Number.NEGATIVE_INFINITY;
  const interval = tierFor(whale.last_active_at, now).everyMinutes * MINUTE;
  return synced + interval - now;
}

export function isDue(whale: SyncCandidate, now: number): boolean {
  return msUntilDue(whale, now) <= 0;
}

/**
 * Picks which wallets to poll this run: only those due, most overdue first,
 * capped at `limit`.
 *
 * Returning fewer than `limit` is the point. The old query always returned a
 * full batch because something is always the least-recently-synced, so the job
 * spent a full budget every cycle even when nothing needed checking.
 */
export function selectDueWhales<T extends SyncCandidate>(
  whales: readonly T[],
  now: number,
  limit: number
): T[] {
  return whales
    .filter((whale) => isDue(whale, now))
    .sort((a, b) => msUntilDue(a, now) - msUntilDue(b, now))
    .slice(0, Math.max(0, limit));
}

/** Breakdown for logging, so a quiet run explains itself rather than looking broken. */
export function cadenceBreakdown(
  whales: readonly SyncCandidate[],
  now: number
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const whale of whales) {
    const label = tierFor(whale.last_active_at, now).label;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

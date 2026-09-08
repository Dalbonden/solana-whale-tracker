/**
 * Provider budget guard.
 *
 * Free API tiers do not fail gracefully when their monthly allowance runs out —
 * they fail *identically to a transient error*, which is the dangerous part.
 * Birdeye answers `400 {"success":false,"message":"Compute units usage limit
 * exceeded"}` and Helius answers with the bare text `max usage reached`. Both
 * look retryable to `request()`, so a pipeline that hits the wall keeps
 * hammering it: every job, every cycle, with backoff and retries on top.
 *
 * Worse, the retries themselves are billable on some plans, so the failure mode
 * actively spends whatever allowance is left and delays the recovery.
 *
 * This module gives the HTTP layer a memory. The first quota answer from a
 * provider marks it exhausted, and every later call short-circuits without
 * touching the network until a cooldown expires. The cooldown then lets one
 * request through to test whether the allowance has reset, rather than staying
 * dark until the process restarts.
 *
 * WHAT THIS IS NOT
 *
 * It is not a way around a quota. An exhausted provider stays exhausted; this
 * only stops the app burning what remains, and makes the reason visible instead
 * of surfacing as a wall of 429s that read like a network problem.
 *
 * State is deliberately per-process and in-memory: it is an optimisation, and a
 * restart re-probing once is harmless.
 */

export type Provider =
  | 'helius'
  /** A standard-RPC provider that is not Helius, billed by its own account. */
  | 'rpc'
  | 'birdeye'
  | 'jupiter'
  | 'geckoterminal'
  | 'solscan'
  | 'other';

/**
 * How long to stay quiet before testing a provider again.
 *
 * Monthly allowances reset on a date this code cannot know, so the cooldown is
 * a compromise: long enough that a dead provider is not re-probed constantly,
 * short enough that recovery is automatic rather than needing a redeploy.
 */
export const COOLDOWN_MS = 30 * 60_000;

/** Maps an HTTP label like `helius-history` onto the provider that bills it. */
export function providerFromLabel(label: string): Provider {
  const name = label.toLowerCase();
  // Checked before 'helius' would ever match; a separate RPC provider must not
  // share Helius's exhaustion state.
  if (name.startsWith('solana-rpc')) return 'rpc';
  if (name.startsWith('helius')) return 'helius';
  if (name.startsWith('birdeye')) return 'birdeye';
  if (name.startsWith('jupiter')) return 'jupiter';
  if (name.startsWith('gecko')) return 'geckoterminal';
  if (name.startsWith('solscan')) return 'solscan';
  return 'other';
}

/**
 * Detects a quota-exhaustion answer, returning a human reason or null.
 *
 * Kept pure so the signatures can be tested without a network — they are the
 * part most likely to drift when a provider rewords an error, and a signature
 * that silently stops matching turns this guard back into a hammer.
 */
export function quotaSignal(status: number, body: string): string | null {
  const text = (body ?? '').toLowerCase();

  // Helius: plain text, and the status is not reliably a 4xx.
  if (text.includes('max usage reached')) return 'Helius credit allowance is used up';

  // Birdeye: 400 with a JSON envelope.
  if (text.includes('compute units usage limit exceeded')) {
    return 'Birdeye compute-unit allowance is used up';
  }

  if (status === 402) return 'Provider reports payment required';

  // Generic phrasings used by several providers for the same condition.
  if (
    text.includes('monthly limit') ||
    text.includes('quota exceeded') ||
    text.includes('credit limit') ||
    text.includes('usage limit exceeded')
  ) {
    return 'Provider reports its usage allowance is exhausted';
  }

  return null;
}

interface Exhaustion {
  reason: string;
  until: number;
  since: number;
}

/*
 * Held on globalThis for the same reason the scheduler is: Next does not
 * guarantee that route handlers and the instrumentation hook share a module
 * instance, and a per-chunk guard would let one chunk keep spending while
 * another has already given up.
 */
const GLOBAL_KEY = Symbol.for('solana-whale-tracker.budget');

function store(): Map<Provider, Exhaustion> {
  const globals = globalThis as Record<symbol, unknown>;
  if (!globals[GLOBAL_KEY]) globals[GLOBAL_KEY] = new Map<Provider, Exhaustion>();
  return globals[GLOBAL_KEY] as Map<Provider, Exhaustion>;
}

export function markExhausted(provider: Provider, reason: string, cooldownMs = COOLDOWN_MS): void {
  const now = Date.now();
  const existing = store().get(provider);
  store().set(provider, {
    reason,
    until: now + cooldownMs,
    since: existing?.since ?? now,
  });
  console.warn(
    `[budget] ${provider} exhausted: ${reason}. Skipping its calls for ${Math.round(cooldownMs / 60_000)}m.`
  );
}

/** True while the provider should not be called at all. */
export function isExhausted(provider: Provider): boolean {
  const entry = store().get(provider);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    // Cooldown elapsed — let the next call through to test for a reset.
    store().delete(provider);
    return false;
  }
  return true;
}

export function exhaustionReason(provider: Provider): string | null {
  return store().get(provider)?.reason ?? null;
}

/** Clears the record after a provider answers successfully again. */
export function markHealthy(provider: Provider): void {
  if (store().has(provider)) {
    console.info(`[budget] ${provider} is answering again.`);
    store().delete(provider);
  }
}

/** Snapshot for /api/health, so an exhausted provider is visible not inferred. */
export function budgetStatus(): Array<{
  provider: Provider;
  reason: string;
  exhaustedSince: string;
  retryAt: string;
}> {
  return [...store().entries()].map(([provider, entry]) => ({
    provider,
    reason: entry.reason,
    exhaustedSince: new Date(entry.since).toISOString(),
    retryAt: new Date(entry.until).toISOString(),
  }));
}

/** Raised instead of making a call the guard knows will fail. */
export class QuotaExhaustedError extends Error {
  constructor(
    readonly provider: Provider,
    reason: string
  ) {
    super(`${provider} skipped: ${reason}`);
    this.name = 'QuotaExhaustedError';
  }
}

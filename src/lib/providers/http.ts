/**
 * Shared HTTP layer for third-party APIs.
 *
 * Every external provider here is rate limited and occasionally flaky, so all
 * calls go through `request()`: bounded retries with exponential backoff and
 * jitter, honouring `Retry-After`, with a hard per-attempt timeout so a hung
 * upstream can never eat a serverless function's whole budget.
 */

import {
  isExhausted,
  markExhausted,
  markHealthy,
  providerFromLabel,
  QuotaExhaustedError,
  quotaSignal,
} from './budget';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'signal'> {
  /** Per-attempt timeout in ms. Default 15s. */
  timeoutMs?: number;
  /** Retry attempts after the first try. Default 2. */
  retries?: number;
  /** Base backoff in ms; doubles each attempt. Default 400. */
  backoffMs?: number;
  /** Label used in error messages. */
  label?: string;
  /**
   * Attempt the call even while the provider is marked exhausted.
   *
   * Reserved for calls that *reduce* future spend — re-registering the webhook
   * subscription is the case this exists for. Skipping it to save one credit
   * leaves the old, far more expensive subscription in place, so the guard
   * would be protecting the allowance by preserving the thing draining it.
   *
   * A quota answer to a bypassed call still records the exhaustion; it just
   * does not refuse to try.
   */
  bypassBudget?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const {
    timeoutMs = 15_000,
    retries = 2,
    backoffMs = 400,
    label = new URL(url).hostname,
    bypassBudget = false,
    ...init
  } = options;

  /*
   * Refuse before the network, not after.
   *
   * A provider whose allowance is spent answers every call the same way, so
   * without this check each job re-discovers the exhaustion itself — with
   * retries and backoff on top, and on some plans billing for the attempts.
   */
  const provider = providerFromLabel(label);
  if (!bypassBudget && isExhausted(provider)) {
    throw new QuotaExhaustedError(provider, `allowance exhausted; not retrying until cooldown ends`);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        // These are analytics reads against public endpoints; let the platform
        // cache nothing so a cron always sees fresh data.
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');

        // An exhausted allowance is not a transient failure. Retrying it wastes
        // time and, on metered plans, spends what little is left.
        const quota = quotaSignal(response.status, body);
        if (quota) {
          markExhausted(provider, quota);
          throw new QuotaExhaustedError(provider, quota);
        }

        const error = new HttpError(
          `${label} responded ${response.status}`,
          response.status,
          url,
          body.slice(0, 500)
        );

        if (attempt < retries && RETRYABLE_STATUS.has(response.status)) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs * 2 ** attempt + Math.random() * 200;
          await sleep(Math.min(wait, 10_000));
          lastError = error;
          continue;
        }
        throw error;
      }

      // 204 / empty body
      const text = await response.text();

      /*
       * Helius answers `max usage reached` as plain text on a 200, so a quota
       * wall can arrive looking like success. Checking here as well as on the
       * error path is what stops it being reported as a parse failure.
       */
      const quota = quotaSignal(response.status, text);
      if (quota) {
        markExhausted(provider, quota);
        throw new QuotaExhaustedError(provider, quota);
      }

      markHealthy(provider);
      if (!text) return null as T;
      return JSON.parse(text) as T;
    } catch (error) {
      // Never retry past the guard.
      if (error instanceof QuotaExhaustedError) throw error;
      lastError = error;
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const isNetwork = error instanceof TypeError;
      const shouldRetry = attempt < retries && (isAbort || isNetwork);
      if (!shouldRetry) {
        if (error instanceof HttpError) throw error;
        if (isAbort) throw new HttpError(`${label} timed out after ${timeoutMs}ms`, 408, url);
        throw error;
      }
      await sleep(backoffMs * 2 ** attempt + Math.random() * 200);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} request failed`);
}

/**
 * Like `request` but resolves to `fallback` instead of throwing. Used for
 * optional enrichment (labels, logos) where a provider outage must not fail
 * the whole ingest.
 */
export async function requestSoft<T>(
  url: string,
  options: RequestOptions,
  fallback: T
): Promise<T> {
  try {
    return await request<T>(url, options);
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[http] soft failure ${options.label ?? url}:`, (error as Error).message);
    }
    return fallback;
  }
}

/**
 * Runs tasks with bounded concurrency. Third-party rate limits are per-second,
 * so unbounded `Promise.all` over 200 wallets is a guaranteed 429.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Splits an array into fixed-size chunks (batch endpoints, DB upserts). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

/**
 * Jupiter client — keyless pricing, token metadata and wallet balances.
 *
 * WHY THIS EXISTS ALONGSIDE BIRDEYE
 *
 * The three Birdeye endpoints this project most needs — `multi_price`,
 * `token_security` and `wallet/token_list` — are all plan-gated and answer 401
 * on our key, which is why `birdeye.ts` carries a `planRestricted` set and a
 * serial one-mint-at-a-time price fallback. Jupiter serves the same three
 * things with no API key at all. Measured against the live API:
 *
 *   price/v3           100 mints/call, ~5.6 req/s sustained, 0 failures in 20
 *   tokens/v2/search   100 mints/call, returned every mint asked for
 *   ultra/v1/balances  full holdings (2,537 mints for one tracked whale)
 *
 * Beyond replacing what Birdeye withholds, the metadata carries `dev` — the
 * token's deployer. `findMintCreator` otherwise derives that by paging a mint's
 * history back to its genesis transaction, several requests per token; one
 * batched call here covers a hundred. It also carries `audit.devMints`, the
 * number of tokens that deployer has minted, which nothing else in the pipeline
 * currently provides.
 *
 * COVERAGE
 *
 * Verified against an obscure dead pump.fun token (10 holders, organic score 0,
 * launched February 2025): still returned, with its deployer. Coverage is not
 * limited to verified or liquid tokens.
 *
 * WHAT THIS IS NOT
 *
 * `lite-api.jup.ag` is the keyless tier: rate limited by IP, no SLA, and no key
 * to raise the ceiling. It is sized for a cron, not for a user-facing hot path
 * without a cache in front of it. Every function here soft-fails to an empty
 * result rather than throwing, so a Jupiter outage degrades enrichment instead
 * of failing ingest — callers must therefore treat an empty result as "unknown",
 * never as "this token has no deployer".
 */

import { config } from '@/lib/config';
import { NATIVE_SOL } from '@/lib/solana/constants';
import { MAX_IDS_PER_CALL, planBatches } from './batch';
import { mapWithConcurrency, requestSoft } from './http';

/**
 * Measured at ~5.6 req/s with no failures, but that was one unshared IP. Two at
 * a time keeps a burst well inside the ceiling; the batch size is doing the
 * real work here, not the parallelism.
 */
const CONCURRENCY = 2;

const PRICE_TTL_MS = 60_000;

function url(path: string, params: Record<string, string> = {}): string {
  const target = new URL(config.jupiter.baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  return target.toString();
}

// --- Prices ------------------------------------------------------------------

export interface JupiterPrice {
  usdPrice: number;
  /** Pool liquidity in USD. Zero or absent means nothing tradeable is quoting. */
  liquidity: number | null;
  decimals: number | null;
  priceChange24h: number | null;
}

interface RawPrice {
  usdPrice?: number;
  liquidity?: number;
  decimals?: number;
  priceChange24h?: number;
}

const priceCache = new Map<string, { value: JupiterPrice; at: number }>();

/**
 * Full price records for as many mints as Jupiter can quote.
 *
 * Mints with no live pool are simply absent from the response — that is the
 * normal case, not an error. Of 100 mints taken from a tracked whale's bag,
 * around a third came back priced; the rest are dust with no market. Callers
 * must not read absence as a zero price.
 */
export async function getPriceDetails(mints: string[]): Promise<Map<string, JupiterPrice>> {
  const result = new Map<string, JupiterPrice>();
  const pending: string[] = [];

  for (const mint of new Set(mints)) {
    if (!mint) continue;
    const hit = priceCache.get(mint);
    if (hit && Date.now() - hit.at < PRICE_TTL_MS) result.set(mint, hit.value);
    else pending.push(mint);
  }
  if (!pending.length) return result;

  await mapWithConcurrency(planBatches(pending), CONCURRENCY, async (batch) => {
    const payload = await requestSoft<Record<string, RawPrice | null>>(
      url('/price/v3', { ids: batch.join(',') }),
      { label: 'jupiter-price', retries: 2, timeoutMs: 15_000 },
      {}
    );

    for (const [mint, raw] of Object.entries(payload ?? {})) {
      const usdPrice = raw?.usdPrice;
      if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice) || usdPrice <= 0) continue;

      const value: JupiterPrice = {
        usdPrice,
        liquidity: typeof raw?.liquidity === 'number' ? raw.liquidity : null,
        decimals: typeof raw?.decimals === 'number' ? raw.decimals : null,
        priceChange24h: typeof raw?.priceChange24h === 'number' ? raw.priceChange24h : null,
      };
      result.set(mint, value);
      priceCache.set(mint, { value, at: Date.now() });
    }
  });

  return result;
}

/** USD prices only, shaped to match `birdeye.getPrices` so it can stand in for it. */
export async function getPrices(mints: string[]): Promise<Map<string, number>> {
  const details = await getPriceDetails(mints);
  const out = new Map<string, number>();
  for (const [mint, price] of details) out.set(mint, price.usdPrice);
  return out;
}

export async function getPrice(mint: string): Promise<number | null> {
  return (await getPriceDetails([mint])).get(mint)?.usdPrice ?? null;
}

// --- Token metadata ----------------------------------------------------------

export interface JupiterTokenMeta {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** The deployer. Absent on a minority of tokens. */
  dev: string | null;
  /** How many mints that deployer has created. Null when Jupiter does not say. */
  devMints: number | null;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  /** Percent of supply held by the top holders, 0..100. */
  topHoldersPct: number | null;
  /** Percent of supply still held by the deployer, 0..100. */
  devBalancePct: number | null;
  /** Jupiter's 0..100 organic-activity score; low means wash-traded or dead. */
  organicScore: number | null;
  organicScoreLabel: string | null;
  isVerified: boolean;
  holderCount: number | null;
  mcap: number | null;
  liquidity: number | null;
  /** When the first pool was created — the launch moment, without walking trades. */
  firstPoolAt: string | null;
  createdAt: string | null;
}

interface RawToken {
  id?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  dev?: string;
  holderCount?: number;
  mcap?: number;
  liquidity?: number;
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  createdAt?: string;
  firstPool?: { createdAt?: string };
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMints?: number;
  };
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

function toMeta(raw: RawToken): JupiterTokenMeta | null {
  if (!raw?.id) return null;
  const audit = raw.audit ?? {};
  return {
    mint: raw.id,
    symbol: raw.symbol ?? '',
    name: raw.name ?? '',
    decimals: numberOrNull(raw.decimals) ?? 0,
    dev: raw.dev || null,
    devMints: numberOrNull(audit.devMints),
    mintAuthorityDisabled: boolOrNull(audit.mintAuthorityDisabled),
    freezeAuthorityDisabled: boolOrNull(audit.freezeAuthorityDisabled),
    topHoldersPct: numberOrNull(audit.topHoldersPercentage),
    devBalancePct: numberOrNull(audit.devBalancePercentage),
    organicScore: numberOrNull(raw.organicScore),
    organicScoreLabel: raw.organicScoreLabel ?? null,
    isVerified: raw.isVerified === true,
    holderCount: numberOrNull(raw.holderCount),
    mcap: numberOrNull(raw.mcap),
    liquidity: numberOrNull(raw.liquidity),
    firstPoolAt: raw.firstPool?.createdAt ?? null,
    createdAt: raw.createdAt ?? null,
  };
}

/**
 * Metadata for up to 100 mints per request.
 *
 * Unlike the price endpoint this returned every mint asked for in testing,
 * including illiquid ones — but a mint Jupiter has never indexed is still
 * simply absent, so callers check for presence rather than assuming a hit.
 */
export async function getTokenMeta(mints: string[]): Promise<Map<string, JupiterTokenMeta>> {
  const result = new Map<string, JupiterTokenMeta>();
  const unique = [...new Set(mints)].filter(Boolean);
  if (!unique.length) return result;

  await mapWithConcurrency(planBatches(unique), CONCURRENCY, async (batch) => {
    const payload = await requestSoft<RawToken[]>(
      url('/tokens/v2/search', { query: batch.join(',') }),
      { label: 'jupiter-tokens', retries: 2, timeoutMs: 20_000 },
      []
    );

    for (const raw of Array.isArray(payload) ? payload : []) {
      const meta = toMeta(raw);
      if (meta) result.set(meta.mint, meta);
    }
  });

  return result;
}

/**
 * The deployer of a single mint, if Jupiter knows it.
 *
 * `null` means "Jupiter could not tell us" — which covers an unindexed token, a
 * token with no `dev` field, and a network failure alike. It never means "this
 * token has no deployer", so callers keep their own fallback path.
 */
export async function getMintCreator(
  mint: string
): Promise<{ address: string; devMints: number | null } | null> {
  const meta = (await getTokenMeta([mint])).get(mint);
  if (!meta?.dev) return null;
  return { address: meta.dev, devMints: meta.devMints };
}

// --- Wallet balances ---------------------------------------------------------

export interface JupiterBalance {
  mint: string;
  uiAmount: number;
  /** Raw base-unit amount as a string, to avoid precision loss on big supplies. */
  amount: string;
  isFrozen: boolean;
}

interface RawBalance {
  amount?: string;
  uiAmount?: number;
  isFrozen?: boolean;
}

/**
 * Every token a wallet holds, to be priced separately via `getPriceDetails`.
 *
 * Native SOL arrives under the key `SOL`; it is normalised to the wrapped-SOL
 * mint so callers deal in mint addresses throughout.
 *
 * Expect a long tail — one tracked whale returned 2,537 mints, of which roughly
 * a third had any live price at all. Filter before pricing.
 */
export async function getWalletBalances(wallet: string): Promise<JupiterBalance[]> {
  if (!wallet) return [];

  const payload = await requestSoft<Record<string, RawBalance>>(
    url(`/ultra/v1/balances/${wallet}`),
    { label: 'jupiter-balances', retries: 1, timeoutMs: 25_000 },
    {}
  );

  const out: JupiterBalance[] = [];
  for (const [key, raw] of Object.entries(payload ?? {})) {
    const uiAmount = numberOrNull(raw?.uiAmount);
    if (uiAmount === null || uiAmount <= 0) continue;
    out.push({
      mint: key === 'SOL' ? NATIVE_SOL : key,
      uiAmount,
      amount: raw?.amount ?? '0',
      isFrozen: raw?.isFrozen === true,
    });
  }
  return out;
}

// --- Health ------------------------------------------------------------------

export async function ping(): Promise<boolean> {
  const payload = await requestSoft<Record<string, RawPrice | null>>(
    url('/price/v3', { ids: NATIVE_SOL }),
    { label: 'jupiter-ping', retries: 0, timeoutMs: 8_000 },
    {}
  );
  return typeof payload?.[NATIVE_SOL]?.usdPrice === 'number';
}

/** Largest id list that fits in one request, for callers that pre-chunk work. */
export const BATCH_SIZE = MAX_IDS_PER_CALL;

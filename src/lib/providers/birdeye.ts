/**
 * Birdeye client — USD pricing, token metadata, OHLCV candles, wallet holdings
 * and top-trader discovery.
 *
 * Prices are memoised for the lifetime of a request/invocation: a single sync
 * run values hundreds of trades against the same handful of mints, and Birdeye
 * bills per call.
 */

import { config } from '@/lib/config';
import type { OhlcvCandle } from '@/types';
import { chunk, requestSoft, request } from './http';

interface BirdeyeEnvelope<T> {
  success: boolean;
  data: T;
}

function headers(): Record<string, string> {
  return {
    'X-API-KEY': config.birdeye.apiKey,
    'x-chain': 'solana',
  };
}

function url(path: string, params: Record<string, string | number | undefined> = {}): string {
  const target = new URL(config.birdeye.baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

// --- Price cache -------------------------------------------------------------

const PRICE_TTL_MS = 60_000;
const priceCache = new Map<string, { value: number; at: number }>();

function readCache(mint: string): number | undefined {
  const hit = priceCache.get(mint);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.value;
  return undefined;
}

/**
 * USD prices for up to N mints. Returns a partial map — a missing mint means
 * Birdeye has no price (illiquid or brand-new), which callers treat as $0
 * rather than as an error.
 */
export async function getPrices(mints: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!config.birdeye.enabled) return result;

  const pending: string[] = [];
  for (const mint of new Set(mints)) {
    const cached = readCache(mint);
    if (cached !== undefined) result.set(mint, cached);
    else pending.push(mint);
  }
  if (!pending.length) return result;

  // multi_price accepts a comma-separated list; keep batches small enough to
  // stay under URL length limits.
  for (const batch of chunk(pending, 50)) {
    const payload = await requestSoft<
      BirdeyeEnvelope<Record<string, { value: number } | null>>
    >(
      url('/defi/multi_price', { list_address: batch.join(','), include_liquidity: 'false' }),
      { headers: headers(), label: 'birdeye-multi-price', retries: 2 },
      { success: false, data: {} }
    );

    for (const [mint, entry] of Object.entries(payload?.data ?? {})) {
      const value = entry?.value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        result.set(mint, value);
        priceCache.set(mint, { value, at: Date.now() });
      }
    }
  }

  return result;
}

export async function getPrice(mint: string): Promise<number | null> {
  const prices = await getPrices([mint]);
  return prices.get(mint) ?? null;
}

// --- Token metadata ----------------------------------------------------------

export interface BirdeyeTokenOverview {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string | null;
  price: number | null;
  liquidity: number | null;
  mc: number | null;
  v24hUSD: number | null;
  priceChange24hPercent: number | null;
  holder: number | null;
}

export async function getTokenOverview(mint: string): Promise<BirdeyeTokenOverview | null> {
  if (!config.birdeye.enabled) return null;
  const payload = await requestSoft<BirdeyeEnvelope<BirdeyeTokenOverview>>(
    url('/defi/token_overview', { address: mint }),
    { headers: headers(), label: 'birdeye-overview' },
    { success: false, data: null as unknown as BirdeyeTokenOverview }
  );
  return payload?.data ?? null;
}

/** Trending / highest-volume tokens — the candidate pool for auto-discovery. */
export async function getTrendingTokens(limit = 50): Promise<BirdeyeTokenOverview[]> {
  if (!config.birdeye.enabled) return [];
  const payload = await requestSoft<
    BirdeyeEnvelope<{ tokens: BirdeyeTokenOverview[] }>
  >(
    url('/defi/tokenlist', {
      sort_by: 'v24hUSD',
      sort_type: 'desc',
      offset: 0,
      limit: Math.min(limit, 50),
      min_liquidity: 50_000,
    }),
    { headers: headers(), label: 'birdeye-tokenlist' },
    { success: false, data: { tokens: [] } }
  );
  return payload?.data?.tokens ?? [];
}

// --- Charts ------------------------------------------------------------------

export type CandleInterval = '1m' | '5m' | '15m' | '1H' | '4H' | '1D';

export async function getOhlcv(
  mint: string,
  interval: CandleInterval = '15m',
  lookbackHours = 24
): Promise<OhlcvCandle[]> {
  if (!config.birdeye.enabled) return [];
  const now = Math.floor(Date.now() / 1000);
  const payload = await requestSoft<BirdeyeEnvelope<{ items: OhlcvCandle[] }>>(
    url('/defi/ohlcv', {
      address: mint,
      type: interval,
      time_from: now - lookbackHours * 3600,
      time_to: now,
    }),
    { headers: headers(), label: 'birdeye-ohlcv', timeoutMs: 20_000 },
    { success: false, data: { items: [] } }
  );
  return payload?.data?.items ?? [];
}

// --- Wallet ------------------------------------------------------------------

export interface BirdeyeWalletItem {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: number;
  uiAmount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  logoURI: string | null;
}

/**
 * Priced wallet holdings in one call. Cheaper and richer than RPC + price
 * lookups, so it is preferred when a Birdeye key is present.
 */
export async function getWalletPortfolio(wallet: string): Promise<BirdeyeWalletItem[]> {
  if (!config.birdeye.enabled) return [];
  const payload = await requestSoft<
    BirdeyeEnvelope<{ wallet: string; totalUsd: number; items: BirdeyeWalletItem[] }>
  >(
    url('/v1/wallet/token_list', { wallet }),
    { headers: headers(), label: 'birdeye-wallet', timeoutMs: 20_000 },
    { success: false, data: { wallet, totalUsd: 0, items: [] } }
  );
  return payload?.data?.items ?? [];
}

export interface BirdeyeTopTrader {
  owner: string;
  tags: string[] | null;
  type: string;
  volume: number;
  trade: number;
  tradeBuy: number;
  tradeSell: number;
  volumeBuy: number;
  volumeSell: number;
}

/**
 * Highest-volume traders of a token over a window. This is the primary whale
 * discovery source: it surfaces wallets that are *actively trading* a meme,
 * not just sitting on a bag.
 */
export async function getTopTraders(
  mint: string,
  opts: { timeFrame?: '30m' | '1h' | '2h' | '4h' | '8h' | '24h'; limit?: number } = {}
): Promise<BirdeyeTopTrader[]> {
  if (!config.birdeye.enabled) return [];
  const { timeFrame = '24h', limit = 10 } = opts;
  const payload = await requestSoft<BirdeyeEnvelope<{ items: BirdeyeTopTrader[] }>>(
    url('/defi/v2/tokens/top_traders', {
      address: mint,
      time_frame: timeFrame,
      sort_type: 'desc',
      sort_by: 'volume',
      offset: 0,
      limit: Math.min(limit, 10),
    }),
    { headers: headers(), label: 'birdeye-top-traders' },
    { success: false, data: { items: [] } }
  );
  return payload?.data?.items ?? [];
}

/** Throws (rather than soft-failing) so `/api/health` can report the real error. */
export async function ping(): Promise<boolean> {
  if (!config.birdeye.enabled) return false;
  await request(url('/defi/price', { address: 'So11111111111111111111111111111111111111112' }), {
    headers: headers(),
    label: 'birdeye-ping',
    retries: 0,
    timeoutMs: 8_000,
  });
  return true;
}

/**
 * Pump.fun client — public frontend endpoints.
 *
 * These are undocumented and change without notice, so every call soft-fails to
 * an empty result and the shapes are validated defensively. Pump.fun data is an
 * enrichment path (new-launch discovery, snipe detection), never a hard
 * dependency: the tracker works fine when it returns nothing.
 */

import { config } from '@/lib/config';
import { requestSoft } from './http';

export interface PumpfunCoin {
  mint: string;
  name: string;
  symbol: string;
  description: string | null;
  image_uri: string | null;
  creator: string;
  created_timestamp: number;
  usd_market_cap: number | null;
  market_cap: number | null;
  raydium_pool: string | null;
  complete: boolean;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
}

function url(path: string, params: Record<string, string | number | undefined> = {}): string {
  const target = new URL(config.pumpfun.baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

function isCoin(value: unknown): value is PumpfunCoin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PumpfunCoin).mint === 'string' &&
    typeof (value as PumpfunCoin).symbol === 'string'
  );
}

function normalise(raw: unknown): PumpfunCoin[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCoin);
}

/** Most recently created coins. */
export async function getLatestLaunches(limit = 50): Promise<PumpfunCoin[]> {
  const raw = await requestSoft<unknown>(
    url('/coins', {
      offset: 0,
      limit: Math.min(limit, 100),
      sort: 'created_timestamp',
      order: 'DESC',
      includeNsfw: 'false',
    }),
    { label: 'pumpfun-latest', retries: 1, timeoutMs: 12_000 },
    []
  );
  return normalise(raw);
}

/**
 * Coins that completed their bonding curve and migrated to Raydium. These
 * matter most: graduation is the point at which whales can size in.
 */
export async function getGraduatedCoins(limit = 50): Promise<PumpfunCoin[]> {
  const raw = await requestSoft<unknown>(
    url('/coins', {
      offset: 0,
      limit: Math.min(limit, 100),
      sort: 'last_trade_timestamp',
      order: 'DESC',
      complete: 'true',
      includeNsfw: 'false',
    }),
    { label: 'pumpfun-graduated', retries: 1, timeoutMs: 12_000 },
    []
  );
  return normalise(raw).filter((coin) => coin.complete);
}

export async function getCoin(mint: string): Promise<PumpfunCoin | null> {
  const raw = await requestSoft<unknown>(
    url(`/coins/${mint}`),
    { label: 'pumpfun-coin', retries: 1, timeoutMs: 10_000 },
    null
  );
  return isCoin(raw) ? raw : null;
}

/**
 * Launch time for a mint, used by snipe detection. Returns null when pump.fun
 * does not know the mint (i.e. it is not a pump.fun launch).
 */
export async function getLaunchTime(mint: string): Promise<Date | null> {
  const coin = await getCoin(mint);
  if (!coin?.created_timestamp) return null;
  return new Date(coin.created_timestamp);
}

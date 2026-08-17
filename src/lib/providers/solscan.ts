/**
 * Solscan Pro client — optional enrichment.
 *
 * Used for two things Helius/Birdeye do not give us cheaply: exchange/entity
 * labels for known accounts, and a DeFi-activity backfill when a wallet's
 * history predates our first sync. Everything here degrades to null/empty when
 * SOLSCAN_API_KEY is unset.
 */

import { config } from '@/lib/config';
import { requestSoft } from './http';

interface SolscanEnvelope<T> {
  success: boolean;
  data: T;
}

function headers(): Record<string, string> {
  return { token: config.solscan.apiKey };
}

function url(path: string, params: Record<string, string | number | undefined> = {}): string {
  const target = new URL(config.solscan.baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

export interface SolscanAccountDetail {
  account: string;
  lamports: number;
  type: string;
  executable: boolean;
  account_tags?: string[];
}

/**
 * Account metadata. `account_tags` is how we detect CEX hot wallets, market
 * makers and program-owned accounts, which must never be tracked as whales.
 */
export async function getAccountDetail(address: string): Promise<SolscanAccountDetail | null> {
  if (!config.solscan.enabled) return null;
  const payload = await requestSoft<SolscanEnvelope<SolscanAccountDetail>>(
    url('/account/detail', { address }),
    { headers: headers(), label: 'solscan-account' },
    { success: false, data: null as unknown as SolscanAccountDetail }
  );
  return payload?.data ?? null;
}

const EXCLUDED_TAG_PATTERNS = [
  'exchange',
  'binance',
  'coinbase',
  'okx',
  'bybit',
  'kraken',
  'kucoin',
  'bitget',
  'gate.io',
  'mexc',
  'crypto.com',
  'robinhood',
  'wintermute',
  'jump',
  'alameda',
  'market maker',
  'bridge',
  'wormhole',
  'program',
  'pool',
  'vault',
  'treasury',
];

/**
 * True when an address belongs to an exchange, market maker or protocol.
 * Falls back to `false` (i.e. "treat as a normal wallet") without a Solscan key.
 */
export async function isInstitutionalAccount(address: string): Promise<boolean> {
  const detail = await getAccountDetail(address);
  const tags = detail?.account_tags;
  if (!tags?.length) return false;
  const haystack = tags.join(' ').toLowerCase();
  return EXCLUDED_TAG_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/** Human-friendly label for a known account, if Solscan has one. */
export async function getAccountLabel(address: string): Promise<string | null> {
  const detail = await getAccountDetail(address);
  return detail?.account_tags?.[0] ?? null;
}

export interface SolscanDefiActivity {
  block_time: number;
  trans_id: string;
  activity_type: string;
  from_address: string;
  platform: string[];
  routers?: {
    token1: string;
    token1_decimals: number;
    amount1: number;
    token2: string;
    token2_decimals: number;
    amount2: number;
  };
}

/**
 * Historical swap activity for a wallet. Used to backfill trade history further
 * back than the Helius enhanced-history window we page through on first sync.
 */
export async function getDefiActivities(
  address: string,
  opts: { page?: number; pageSize?: 10 | 20 | 30 | 40 | 60 | 100; token?: string } = {}
): Promise<SolscanDefiActivity[]> {
  if (!config.solscan.enabled) return [];
  const { page = 1, pageSize = 100, token } = opts;
  const payload = await requestSoft<SolscanEnvelope<SolscanDefiActivity[]>>(
    url('/account/defi/activities', {
      address,
      page,
      page_size: pageSize,
      token,
      activity_type: 'ACTIVITY_TOKEN_SWAP',
      sort_by: 'block_time',
      sort_order: 'desc',
    }),
    { headers: headers(), label: 'solscan-defi', timeoutMs: 20_000 },
    { success: false, data: [] }
  );
  return payload?.data ?? [];
}

export interface SolscanTokenMeta {
  address: string;
  name: string;
  symbol: string;
  icon: string | null;
  decimals: number;
  holder: number | null;
  supply: string | null;
  market_cap: number | null;
}

export async function getTokenMeta(mint: string): Promise<SolscanTokenMeta | null> {
  if (!config.solscan.enabled) return null;
  const payload = await requestSoft<SolscanEnvelope<SolscanTokenMeta>>(
    url('/token/meta', { address: mint }),
    { headers: headers(), label: 'solscan-token-meta' },
    { success: false, data: null as unknown as SolscanTokenMeta }
  );
  return payload?.data ?? null;
}

/**
 * Meme token filter.
 *
 * Two layers:
 *   1. The **universe** — the `meme_tokens` table. Seeded with a curated core
 *      list (WIF, BONK, POPCAT, MEW, SAMO, …) and extended at runtime, either
 *      manually via `POST /api/tokens` or automatically by the discovery cron.
 *   2. The **classifier** — heuristics that decide whether an unknown mint
 *      deserves to enter the universe. Nothing is auto-added without clearing
 *      liquidity and volume floors, so the tracker does not fill up with dead
 *      rug tokens.
 */

import { getToken, listActiveMints, upsertTokens } from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import * as pumpfun from '@/lib/providers/pumpfun';
import { NON_MEME_MINTS, looksLikePumpfunMint } from '@/lib/solana/constants';
import type { MemeToken } from '@/types';

/** Curated always-on list. Mirrors supabase/seed.sql. */
export const CORE_MEME_TOKENS: Array<{
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}> = [
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', name: 'dogwifhat', decimals: 6 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5 },
  { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'POPCAT', name: 'Popcat', decimals: 9 },
  { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', name: 'cat in a dogs world', decimals: 5 },
  { mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', symbol: 'SAMO', name: 'Samoyedcoin', decimals: 9 },
  { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME', name: 'BOOK OF MEME', decimals: 6 },
  { mint: 'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', symbol: 'FWOG', name: 'Fwog', decimals: 6 },
  { mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', symbol: 'AI16Z', name: 'ai16z', decimals: 9 },
  { mint: '6ogzHhzdrQr9Pgv6hZ2MNze7UrzBMAFyBBWUYp1Fhitx', symbol: 'RETARDIO', name: 'RETARDIO', decimals: 6 },
];

export const CORE_MINTS = new Set(CORE_MEME_TOKENS.map((token) => token.mint));

/** Floors an auto-discovered token must clear to enter the universe. */
export const AUTO_ADD_THRESHOLDS = {
  minLiquidityUsd: 100_000,
  minVolume24hUsd: 250_000,
  minMarketCapUsd: 500_000,
  /** Above this market cap a token is treated as an established asset, not a meme play. */
  maxMarketCapUsd: 5_000_000_000,
} as const;

// ---------------------------------------------------------------------------
// Universe cache
// ---------------------------------------------------------------------------

let universeCache: { mints: Set<string>; at: number } | null = null;
const UNIVERSE_TTL_MS = 60_000;

/**
 * The set of mints currently tracked. Cached briefly because ingest calls this
 * once per transaction and a serverless invocation may process hundreds.
 */
export async function getTrackedMints(force = false): Promise<Set<string>> {
  if (!force && universeCache && Date.now() - universeCache.at < UNIVERSE_TTL_MS) {
    return universeCache.mints;
  }
  const mints = new Set(await listActiveMints());
  // The core list is always tracked even if the seed has not been applied yet.
  for (const mint of CORE_MINTS) mints.add(mint);
  universeCache = { mints, at: Date.now() };
  return mints;
}

export function invalidateUniverseCache(): void {
  universeCache = null;
}

/** Predicate factory for the swap parser. */
export async function createMemeFilter(): Promise<(mint: string) => boolean> {
  const tracked = await getTrackedMints();
  return (mint: string) => tracked.has(mint) && !NON_MEME_MINTS.has(mint);
}

export function isExcludedMint(mint: string): boolean {
  return NON_MEME_MINTS.has(mint);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  isMeme: boolean;
  confidence: number;
  reasons: string[];
  source: MemeToken['source'];
}

const MEME_NAME_PATTERNS = [
  /\b(dog|doge|shib|inu|wif|hat|cat|kitty|pepe|frog|wojak|chad|moon|rocket)\b/i,
  /\b(bonk|floki|elon|trump|baby|mini|giga|based|retard|fart|poop|coom)\b/i,
  /\b(meme|coin|pump|ai16z|goat|banana|monkey|ape|penguin|bear|bull)\b/i,
];

/**
 * Decides whether an unknown mint belongs in the meme universe.
 *
 * The strongest signal is provenance: anything launched on pump.fun is a meme
 * token by construction. Otherwise we require real liquidity plus either a
 * name/symbol that reads as a meme or a market-cap profile that fits one.
 */
export async function classifyToken(mint: string): Promise<ClassificationResult> {
  const reasons: string[] = [];

  if (NON_MEME_MINTS.has(mint)) {
    return { isMeme: false, confidence: 1, reasons: ['blue-chip / stable / LST denylist'], source: 'auto' };
  }

  if (CORE_MINTS.has(mint)) {
    return { isMeme: true, confidence: 1, reasons: ['core curated list'], source: 'core' };
  }

  let confidence = 0;
  let source: MemeToken['source'] = 'auto';

  if (looksLikePumpfunMint(mint)) {
    confidence += 0.55;
    source = 'pumpfun';
    reasons.push('pump.fun mint suffix');
  }

  const overview = await birdeye.getTokenOverview(mint);
  if (!overview) {
    return {
      isMeme: confidence >= 0.5,
      confidence,
      reasons: [...reasons, 'no market data available'],
      source,
    };
  }

  const liquidity = overview.liquidity ?? 0;
  const volume = overview.v24hUSD ?? 0;
  const marketCap = overview.mc ?? 0;

  if (liquidity < AUTO_ADD_THRESHOLDS.minLiquidityUsd) {
    reasons.push(`liquidity $${Math.round(liquidity).toLocaleString()} below floor`);
    return { isMeme: false, confidence, reasons, source };
  }
  if (volume < AUTO_ADD_THRESHOLDS.minVolume24hUsd) {
    reasons.push(`24h volume $${Math.round(volume).toLocaleString()} below floor`);
    return { isMeme: false, confidence, reasons, source };
  }
  if (marketCap > AUTO_ADD_THRESHOLDS.maxMarketCapUsd) {
    reasons.push('market cap too large — treated as an established asset');
    return { isMeme: false, confidence, reasons, source };
  }

  confidence += 0.2;
  reasons.push('clears liquidity and volume floors');

  const haystack = `${overview.name ?? ''} ${overview.symbol ?? ''}`;
  if (MEME_NAME_PATTERNS.some((pattern) => pattern.test(haystack))) {
    confidence += 0.3;
    reasons.push('name/symbol matches meme vocabulary');
  }

  // A very high volume-to-market-cap ratio is the signature of speculative
  // rotation rather than of an asset people hold for utility.
  if (marketCap > 0 && volume / marketCap > 0.3) {
    confidence += 0.2;
    reasons.push('turnover ratio consistent with speculative trading');
  }

  if (marketCap >= AUTO_ADD_THRESHOLDS.minMarketCapUsd && marketCap < 500_000_000) {
    confidence += 0.1;
    reasons.push('market cap in meme-token band');
  }

  return { isMeme: confidence >= 0.6, confidence: Math.min(confidence, 1), reasons, source };
}

// ---------------------------------------------------------------------------
// Universe mutation
// ---------------------------------------------------------------------------

/**
 * Adds a token to the universe, pulling metadata from Birdeye. `force` skips
 * classification — used by the manual `POST /api/tokens` route, where a human
 * has already made the call.
 */
export async function addTokenToUniverse(
  mint: string,
  opts: { force?: boolean; source?: MemeToken['source'] } = {}
): Promise<{ added: boolean; token?: Partial<MemeToken>; reason?: string }> {
  const existing = await getToken(mint);
  if (existing?.is_active) return { added: false, reason: 'already tracked', token: existing };

  if (!opts.force) {
    const classification = await classifyToken(mint);
    if (!classification.isMeme) {
      return { added: false, reason: classification.reasons.join('; ') };
    }
  }

  const [overview, pumpCoin] = await Promise.all([
    birdeye.getTokenOverview(mint),
    looksLikePumpfunMint(mint) ? pumpfun.getCoin(mint) : Promise.resolve(null),
  ]);

  if (!overview && !pumpCoin && !opts.force) {
    return { added: false, reason: 'no metadata found for mint' };
  }

  const token: Partial<MemeToken> = {
    mint,
    symbol: overview?.symbol ?? pumpCoin?.symbol ?? mint.slice(0, 6),
    name: overview?.name ?? pumpCoin?.name ?? null,
    decimals: overview?.decimals ?? 6,
    logo_uri: overview?.logoURI ?? pumpCoin?.image_uri ?? null,
    source: opts.source ?? (pumpCoin ? 'pumpfun' : 'birdeye'),
    is_core: CORE_MINTS.has(mint),
    is_active: true,
    price_usd: overview?.price ?? null,
    market_cap_usd: overview?.mc ?? pumpCoin?.usd_market_cap ?? null,
    liquidity_usd: overview?.liquidity ?? null,
    volume_24h_usd: overview?.v24hUSD ?? null,
    price_change_24h: overview?.priceChange24hPercent ?? null,
    holder_count: overview?.holder ?? null,
    pumpfun_created_at: pumpCoin?.created_timestamp
      ? new Date(pumpCoin.created_timestamp).toISOString()
      : null,
    pumpfun_graduated: pumpCoin?.complete ?? false,
    last_refreshed_at: new Date().toISOString(),
  };

  await upsertTokens([token]);
  invalidateUniverseCache();
  return { added: true, token };
}

/** Ensures the curated core list exists. Safe to call on every deploy. */
export async function ensureCoreTokens(): Promise<number> {
  const rows: Partial<MemeToken>[] = CORE_MEME_TOKENS.map((token) => ({
    ...token,
    source: 'core' as const,
    is_core: true,
    is_active: true,
  }));
  const written = await upsertTokens(rows);
  invalidateUniverseCache();
  return written;
}

/** Refreshes cached market data for the tracked universe. */
export async function refreshTokenMarketData(mints: string[]): Promise<number> {
  if (!mints.length) return 0;

  const updates: Partial<MemeToken>[] = [];
  const now = new Date().toISOString();

  // Overviews are one call per mint, so cap the batch to stay inside the
  // function timeout and the Birdeye rate limit.
  const { mapWithConcurrency } = await import('@/lib/providers/http');
  await mapWithConcurrency(mints.slice(0, 100), 4, async (mint) => {
    const overview = await birdeye.getTokenOverview(mint);
    if (!overview) return;
    updates.push({
      mint,
      symbol: overview.symbol || mint.slice(0, 6),
      name: overview.name ?? null,
      decimals: overview.decimals ?? 6,
      logo_uri: overview.logoURI ?? null,
      price_usd: overview.price ?? null,
      market_cap_usd: overview.mc ?? null,
      liquidity_usd: overview.liquidity ?? null,
      volume_24h_usd: overview.v24hUSD ?? null,
      price_change_24h: overview.priceChange24hPercent ?? null,
      holder_count: overview.holder ?? null,
      last_refreshed_at: now,
    });
  });

  return upsertTokens(updates);
}

/**
 * Pulls freshly graduated pump.fun coins and admits the ones that pass
 * classification. This is what keeps the universe current without manual work.
 */
export async function discoverNewMemeTokens(limit = 30): Promise<{
  evaluated: number;
  added: string[];
}> {
  const [graduated, trending] = await Promise.all([
    pumpfun.getGraduatedCoins(limit),
    birdeye.getTrendingTokens(limit),
  ]);

  const tracked = await getTrackedMints(true);
  const candidates = new Set<string>();

  for (const coin of graduated) {
    if (!tracked.has(coin.mint)) candidates.add(coin.mint);
  }
  for (const token of trending) {
    if (token.address && !tracked.has(token.address) && !NON_MEME_MINTS.has(token.address)) {
      candidates.add(token.address);
    }
  }

  const added: string[] = [];
  const { mapWithConcurrency } = await import('@/lib/providers/http');

  await mapWithConcurrency([...candidates].slice(0, limit), 3, async (mint) => {
    const result = await addTokenToUniverse(mint);
    if (result.added) added.push(mint);
  });

  return { evaluated: candidates.size, added };
}

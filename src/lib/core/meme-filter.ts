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

import { getToken, listActiveMints, listTokens, upsertTokens } from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import * as jupiter from '@/lib/providers/jupiter';
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
  // NOTE: a "CATS" entry was removed here — the mint carried no price, no
  // liquidity and zero holders on Birdeye, i.e. it was not a tradeable token.
  // Verify a mint on Birdeye or Solscan before adding it to the core list.
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

/*
 * Organic-volume thresholds, set from measurement rather than intuition.
 *
 * Measured across the tracked universe, genuinely traded meme tokens span a
 * far wider range than expected: BOME 0.6%, MEW 1.1%, WIF 7.3%, BONK 8.2%,
 * POPCAT 8.3%, FWOG 28.6%. An earlier 2% floor would therefore have rejected
 * BOME and MEW — both real, both already curated — which is the same mistake
 * this codebase keeps having to undo: a filter that reads a limitation of the
 * signal as a fact about the subject.
 *
 * So near-zero is the only level that actually distinguishes wash trading, and
 * even that is only meaningful once there is enough volume for the ratio to
 * mean anything. Between the two bounds the share informs confidence instead of
 * deciding admission.
 */
const WASH_TRADE_ORGANIC_SHARE = 0.001;
/** Below this, the organic ratio is too noisy to reject anything on. */
const WASH_TRADE_MIN_VOLUME_USD = 50_000;
/** A comfortably organic token earns a small bonus. */
const HEALTHY_ORGANIC_SHARE = 0.05;

/*
 * Deployer launch count above which a token is treated as factory output.
 *
 * Measured across the live universe. Every curated token's deployer has minted
 * at most 222 tokens, and eight of the nine have minted 15 or fewer:
 *
 *   AI16Z 1 · SAMO 1 · BOME 1 · MEW 2 · POPCAT 5 · RETARDIO 6 · BONK 10 ·
 *   WIF 15 · FWOG 222
 *
 * The auto-discovered set is different in kind: median 2, but p75 of 881 and a
 * maximum of 19,614. Eleven of forty-five came from deployers with more than a
 * thousand mints, and one wallet with 8,027 mints produced seven of them —
 * BUTTHOLE, PURR, FRIES, STONK, ZCAT, USEFUL and BTC. A wallet that mints both
 * "BTC" and "BUTTHOLE" is a token factory, not somebody launching a project.
 *
 * 1,000 sits in the gap with 4.5x headroom over the highest curated value, so
 * it separates the two populations without touching anything known-good. It
 * also excludes institutional issuance — the xStocks tokenized equities share
 * an issuer wallet at 1,331 — which belongs out of a meme universe anyway.
 *
 * Checked on-chain: these are ordinary wallets, `executable=false` and owned by
 * the System Program, not launchpad programs. The count is real.
 */
const MAX_DEPLOYER_MINTS = 1_000;

interface TokenSnapshot {
  symbol: string | null;
  name: string | null;
  liquidity: number | null;
  volume24h: number | null;
  marketCap: number | null;
  /** Jupiter only; null means unknown, never zero. */
  organicVolume24h: number | null;
  /** How many mints this token's deployer has created. Jupiter only. */
  deployerMints: number | null;
}

/**
 * Market snapshot for one mint, from whichever provider can answer.
 *
 * Jupiter first because it is keyless and unmetered, so classification during a
 * discovery sweep no longer spends Birdeye compute units per candidate. Birdeye
 * remains the fallback for mints Jupiter has never indexed.
 */
async function tokenSnapshot(mint: string): Promise<TokenSnapshot | null> {
  const meta = (await jupiter.getTokenMeta([mint])).get(mint);
  if (meta) {
    return {
      symbol: meta.symbol || null,
      name: meta.name || null,
      liquidity: meta.liquidity,
      volume24h: meta.volume24hUsd,
      marketCap: meta.mcap,
      organicVolume24h: meta.organicVolume24hUsd,
      deployerMints: meta.devMints,
    };
  }

  const overview = await birdeye.getTokenOverview(mint);
  if (!overview) return null;
  return {
    symbol: overview.symbol ?? null,
    name: overview.name ?? null,
    liquidity: overview.liquidity ?? null,
    volume24h: overview.v24hUSD ?? null,
    marketCap: birdeye.marketCapOf(overview),
    organicVolume24h: null,
    deployerMints: null,
  };
}

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

  const snapshot = await tokenSnapshot(mint);
  if (!snapshot) {
    return {
      isMeme: confidence >= 0.5,
      confidence,
      reasons: [...reasons, 'no market data available'],
      source,
    };
  }

  const liquidity = snapshot.liquidity ?? 0;
  const volume = snapshot.volume24h ?? 0;
  const marketCap = snapshot.marketCap ?? 0;

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

  const haystack = `${snapshot.name ?? ''} ${snapshot.symbol ?? ''}`;
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

  /*
   * Volume floors are trivially faked, and the turnover bonus above rewards
   * exactly the pattern a wash trader produces. Jupiter reports how much of the
   * volume it attributes to organic traders, so a token whose reported volume
   * is real but whose organic share is negligible can be rejected rather than
   * scored highly for its churn. Only applied when the figure is available --
   * Birdeye has no equivalent, and absence is not evidence.
   */
  /*
   * Factory output is not a meme token.
   *
   * Volume, liquidity and market cap all look ordinary on a token minted by a
   * wallet that has minted thousands of others — the numbers describe the
   * market, not the provenance. This is the only check that asks who made it.
   *
   * Only applied when the count is known; Birdeye has no equivalent field, and
   * absence is not evidence.
   */
  if (snapshot.deployerMints !== null && snapshot.deployerMints > MAX_DEPLOYER_MINTS) {
    reasons.push(
      `deployer has minted ${snapshot.deployerMints.toLocaleString()} tokens — factory output, not a project`
    );
    return { isMeme: false, confidence, reasons, source };
  }

  if (snapshot.organicVolume24h !== null && volume > 0) {
    const organicShare = snapshot.organicVolume24h / volume;

    if (organicShare < WASH_TRADE_ORGANIC_SHARE && volume >= WASH_TRADE_MIN_VOLUME_USD) {
      reasons.push(
        `$${Math.round(volume).toLocaleString()} of 24h volume with essentially none of it organic — reads as wash trading`
      );
      return { isMeme: false, confidence, reasons, source };
    }

    if (organicShare >= HEALTHY_ORGANIC_SHARE) {
      confidence += 0.1;
      reasons.push(`${(organicShare * 100).toFixed(1)}% of volume is organic`);
    }
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

  // Jupiter first, Birdeye only if it has never indexed the mint. Admission
  // runs once per candidate during a discovery sweep, so this was one metered
  // call per evaluation on top of the one classifyToken already made.
  const [meta, pumpCoin] = await Promise.all([
    jupiter.getTokenMeta([mint]).then((m) => m.get(mint) ?? null),
    looksLikePumpfunMint(mint) ? pumpfun.getCoin(mint) : Promise.resolve(null),
  ]);
  const overview = meta ? null : await birdeye.getTokenOverview(mint);

  if (!meta && !overview && !pumpCoin && !opts.force) {
    return { added: false, reason: 'no metadata found for mint' };
  }

  const token: Partial<MemeToken> = {
    mint,
    symbol: meta?.symbol || overview?.symbol || pumpCoin?.symbol || mint.slice(0, 6),
    name: meta?.name || overview?.name || pumpCoin?.name || null,
    decimals: meta?.decimals ?? overview?.decimals ?? 6,
    logo_uri: meta?.logoUri ?? overview?.logoURI ?? pumpCoin?.image_uri ?? null,
    source: opts.source ?? (pumpCoin ? 'pumpfun' : 'birdeye'),
    is_core: CORE_MINTS.has(mint),
    is_active: true,
    price_usd: meta?.usdPrice ?? overview?.price ?? null,
    market_cap_usd:
      meta?.mcap ?? birdeye.marketCapOf(overview ?? null) ?? pumpCoin?.usd_market_cap ?? null,
    liquidity_usd: meta?.liquidity ?? overview?.liquidity ?? null,
    volume_24h_usd: meta?.volume24hUsd ?? overview?.v24hUSD ?? null,
    price_change_24h: meta?.priceChange24h ?? overview?.priceChange24hPercent ?? null,
    holder_count: meta?.holderCount ?? overview?.holder ?? null,
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

/**
 * Refreshes cached market data for the tracked universe.
 *
 * Curated symbols and names are preserved for core tokens. Birdeye reports
 * these as they appear on-chain — "$WIF", "Bonk" — and letting that overwrite
 * the curated list makes the leaderboard inconsistent between refreshes.
 */
export async function refreshTokenMarketData(mints: string[]): Promise<number> {
  if (!mints.length) return 0;

  const updates: Partial<MemeToken>[] = [];
  const now = new Date().toISOString();

  // Existing rows tell us which tokens are curated and what to keep.
  const existing = new Map(
    (await listTokens({ activeOnly: false, limit: 500 })).map((token) => [token.mint, token])
  );

  const wanted = mints.slice(0, 100);

  /*
   * One batched Jupiter call instead of a hundred serial Birdeye ones.
   *
   * `token_overview` is billed per mint and the free tier allows roughly one
   * request a second, so refreshing a hundred tokens meant a hundred metered
   * calls and around a hundred seconds — long enough that it cannot run inside
   * a serverless function at all. Jupiter returns the same fields for a hundred
   * mints in a single keyless request, and adds the organic-volume split, which
   * distinguishes a token being traded from one being wash-traded.
   */
  const meta = await jupiter.getTokenMeta(wanted);

  for (const mint of wanted) {
    const token = meta.get(mint);
    if (!token) continue;

    const current = existing.get(mint);
    const keepCurated = current?.is_core === true;

    updates.push({
      mint,
      symbol: keepCurated ? current.symbol : token.symbol || current?.symbol || mint.slice(0, 6),
      name: keepCurated ? current.name : (token.name || current?.name || null),
      decimals: token.decimals ?? current?.decimals ?? 6,
      logo_uri: token.logoUri ?? current?.logo_uri ?? null,
      price_usd: token.usdPrice,
      market_cap_usd: token.mcap,
      liquidity_usd: token.liquidity,
      volume_24h_usd: token.volume24hUsd,
      price_change_24h: token.priceChange24h,
      holder_count: token.holderCount,
      last_refreshed_at: now,
    });
  }

  /*
   * Birdeye covers only what Jupiter could not identify, and only while its own
   * allowance holds. Falling back for every miss would reintroduce the serial
   * cost this change exists to remove, so the tail is capped — an unrefreshed
   * token keeps its previous values and its stale `last_refreshed_at`, which is
   * honest, where a zeroed row would not be.
   */
  const missed = wanted.filter((mint) => !meta.has(mint));
  const BIRDEYE_TAIL = 10;

  if (missed.length) {
    const { mapWithConcurrency } = await import('@/lib/providers/http');
    if (missed.length > BIRDEYE_TAIL) {
      console.info(
        `[tokens] ${missed.length} mints unknown to Jupiter; refreshing the first ${BIRDEYE_TAIL} via Birdeye.`
      );
    }

    await mapWithConcurrency(missed.slice(0, BIRDEYE_TAIL), 1, async (mint) => {
      const overview = await birdeye.getTokenOverview(mint);
      if (!overview) return;

      const current = existing.get(mint);
      const keepCurated = current?.is_core === true;

      updates.push({
        mint,
        symbol: keepCurated
          ? current.symbol
          : overview.symbol || current?.symbol || mint.slice(0, 6),
        name: keepCurated ? current.name : (overview.name ?? current?.name ?? null),
        decimals: overview.decimals ?? current?.decimals ?? 6,
        logo_uri: overview.logoURI ?? current?.logo_uri ?? null,
        price_usd: overview.price ?? null,
        market_cap_usd: birdeye.marketCapOf(overview),
        liquidity_usd: overview.liquidity ?? null,
        volume_24h_usd: overview.v24hUSD ?? null,
        price_change_24h: overview.priceChange24hPercent ?? null,
        holder_count: overview.holder ?? null,
        last_refreshed_at: now,
      });
    });
  }

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
  /*
   * Three keyless sources instead of one metered one.
   *
   * `trending` is the direct replacement for Birdeye's trending list. `organic`
   * is the addition worth having: it ranks by Jupiter's organic-activity score,
   * so it surfaces tokens with real traders rather than the wash-traded volume
   * that a pure volume ranking puts at the top — the same population the
   * classifier now rejects, so seeding from it wastes fewer evaluations.
   */
  const [graduated, trending, organic] = await Promise.all([
    pumpfun.getGraduatedCoins(limit),
    jupiter.getTokenList('trending', limit),
    jupiter.getTokenList('organic', limit),
  ]);

  const tracked = await getTrackedMints(true);
  const candidates = new Set<string>();

  for (const coin of graduated) {
    if (!tracked.has(coin.mint)) candidates.add(coin.mint);
  }
  for (const token of [...trending, ...organic]) {
    if (token.mint && !tracked.has(token.mint) && !NON_MEME_MINTS.has(token.mint)) {
      candidates.add(token.mint);
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

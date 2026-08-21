/**
 * Birdeye client — USD pricing, token metadata, OHLCV candles, wallet holdings
 * and top-trader discovery.
 *
 * Prices are memoised for the lifetime of a request/invocation: a single sync
 * run values hundreds of trades against the same handful of mints, and Birdeye
 * bills per call.
 */

import { config } from '@/lib/config';
import { STABLE_MINTS } from '@/lib/solana/constants';
import type { OhlcvCandle } from '@/types';
import { chunk, HttpError, mapWithConcurrency, requestSoft, request } from './http';

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

/**
 * Quote mints are cached far longer than traded tokens. Nearly every trade is
 * priced through SOL or a stablecoin, so on a rate-limited key these few mints
 * would otherwise consume most of the request budget — and a five-minute-old
 * SOL price is materially accurate, whereas a five-minute-old price for a fresh
 * meme token is not.
 */
const QUOTE_PRICE_TTL_MS = 300_000;

const QUOTE_MINTS_FOR_TTL = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
]);

const priceCache = new Map<string, { value: number; at: number }>();

function ttlFor(mint: string): number {
  return QUOTE_MINTS_FOR_TTL.has(mint) ? QUOTE_PRICE_TTL_MS : PRICE_TTL_MS;
}

function readCache(mint: string): number | undefined {
  const hit = priceCache.get(mint);
  if (hit && Date.now() - hit.at < ttlFor(mint)) return hit.value;
  return undefined;
}

/**
 * Endpoints this API key is not entitled to.
 *
 * Birdeye gates several endpoints by plan and answers 401 for them regardless
 * of how the request is formed — retrying is pointless and, at one request per
 * second on the free tier, actively harmful. The first 401 records the endpoint
 * here and every later call skips straight to the fallback path.
 */
const planRestricted = new Set<string>();

function isPlanRestricted(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

function cachePrice(mint: string, value: number, into: Map<string, number>): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
  into.set(mint, value);
  priceCache.set(mint, { value, at: Date.now() });
}

/**
 * Single-mint price — the fallback when `multi_price` is not available.
 *
 * Retries generously: the free tier permits roughly one request per second, so
 * 429 is the expected response under any burst, not an error. The shared HTTP
 * layer honours `Retry-After` and backs off exponentially between attempts.
 */
async function fetchSinglePrice(mint: string): Promise<number | null> {
  const payload = await requestSoft<BirdeyeEnvelope<{ value: number } | null>>(
    url('/defi/price', { address: mint }),
    { headers: headers(), label: 'birdeye-price', retries: 4, backoffMs: 1_200 },
    { success: false, data: null }
  );
  const value = payload?.data?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * USD prices for a set of mints. Returns a partial map — a missing mint means
 * Birdeye has no price (illiquid or brand-new), which callers treat as $0
 * rather than as an error.
 *
 * Prefers `multi_price` (one call per 50 mints). That endpoint requires a paid
 * plan, so on a free key the first call 401s and everything falls back to the
 * single-price endpoint, one call per mint. Slower, but this is the hot path
 * for valuing every trade — without a working fallback the entire dataset
 * prices at $0, which is worse than being slow.
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

  if (!planRestricted.has('multi_price')) {
    for (const batch of chunk(pending, 50)) {
      try {
        const payload = await request<BirdeyeEnvelope<Record<string, { value: number } | null>>>(
          url('/defi/multi_price', { list_address: batch.join(','), include_liquidity: 'false' }),
          { headers: headers(), label: 'birdeye-multi-price', retries: 2 }
        );
        for (const [mint, entry] of Object.entries(payload?.data ?? {})) {
          if (entry?.value !== undefined) cachePrice(mint, entry.value, result);
        }
      } catch (error) {
        if (isPlanRestricted(error)) {
          planRestricted.add('multi_price');
          break;
        }
        // Transient failure for this batch — the single-price pass below will
        // pick up whatever is still missing.
      }
    }
  }

  let missing = pending.filter((mint) => !result.has(mint));

  /*
   * Ceiling on the serial fallback. Each price is its own ~1s request, so an
   * unbounded list turns one call into a multi-minute stall that silently eats
   * a job's entire timeout. Callers are expected to pre-filter to mints worth
   * pricing; this is the backstop for when they don't.
   */
  const SERIAL_PRICE_CEILING = 40;
  if (missing.length > SERIAL_PRICE_CEILING) {
    console.warn(
      `[birdeye] ${missing.length} mints need individual price lookups; ` +
        `capping at ${SERIAL_PRICE_CEILING}. Pre-filter the mint list, or use a plan with multi_price.`
    );
    missing = missing.slice(0, SERIAL_PRICE_CEILING);
  }

  if (missing.length) {
    // Strictly serial. The free tier's ~1 req/sec ceiling means any concurrency
    // here just converts into 429s and backoff, which is slower than queuing.
    // Quote mints go first: if the budget runs short, a priced quote leg still
    // values the trade, whereas a priced meme token alone often does not.
    const ordered = [
      ...missing.filter((mint) => QUOTE_MINTS_FOR_TTL.has(mint)),
      ...missing.filter((mint) => !QUOTE_MINTS_FOR_TTL.has(mint)),
    ];

    await mapWithConcurrency(ordered, 1, async (mint) => {
      const value = await fetchSinglePrice(mint);
      if (value !== null) cachePrice(mint, value, result);
    });
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
  /**
   * Market cap. Birdeye renamed this from `mc` to `marketCap`; both are
   * declared so a rename back does not silently null the column again.
   * `fdv` is the last resort — it differs from market cap whenever supply is
   * not fully circulating, so it is only used when nothing better is present.
   */
  marketCap?: number | null;
  mc?: number | null;
  fdv?: number | null;
  v24hUSD: number | null;
  priceChange24hPercent: number | null;
  holder: number | null;
}

/** Reads market cap across the field names Birdeye has used. */
export function marketCapOf(overview: BirdeyeTokenOverview | null): number | null {
  if (!overview) return null;
  return overview.marketCap ?? overview.mc ?? overview.fdv ?? null;
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

// --- Token-level trade and holder feeds --------------------------------------

export interface BirdeyeTokenTrade {
  owner: string;
  side: 'buy' | 'sell';
  blockUnixTime: number;
  txHash: string;
  source: string;
  /** Token units moved on the meme leg. */
  tokenAmount: number;
  /** Value of the trade in USD, from the quote leg where present. */
  usdValue: number | null;
  priceUsd: number | null;
}

/** One side of a swap. `price` is present on the quote leg only. */
interface RawTradeLeg {
  address?: string;
  uiChangeAmount?: number;
  uiAmount?: number;
  price?: number | null;
}

interface RawTokenTrade {
  owner?: string;
  side?: string;
  blockUnixTime?: number;
  txHash?: string;
  source?: string;
  quotePrice?: number | null;
  base?: RawTradeLeg;
  quote?: RawTradeLeg;
}

function normaliseTrade(raw: RawTokenTrade, mint: string): BirdeyeTokenTrade | null {
  if (!raw.owner || !raw.blockUnixTime || !raw.txHash) return null;

  // The meme leg is whichever side of the pair is the token we asked about.
  const baseIsToken = raw.base?.address === mint;
  const tokenLeg = baseIsToken ? raw.base : raw.quote;
  const otherLeg = baseIsToken ? raw.quote : raw.base;

  const tokenAmount = Math.abs(tokenLeg?.uiChangeAmount ?? tokenLeg?.uiAmount ?? 0);
  if (!tokenAmount) return null;

  // Valued from the counter leg, matching how live trades are valued: the quote
  // side is a liquid asset with a trustworthy price, the meme side is not.
  const otherAmount = Math.abs(otherLeg?.uiChangeAmount ?? otherLeg?.uiAmount ?? 0);
  const otherPrice = otherLeg?.price ?? null;
  const usdValue = otherPrice !== null && otherAmount ? otherAmount * otherPrice : null;

  return {
    owner: raw.owner,
    side: raw.side === 'sell' ? 'sell' : 'buy',
    blockUnixTime: raw.blockUnixTime,
    txHash: raw.txHash,
    source: raw.source ?? 'unknown',
    tokenAmount,
    usdValue,
    priceUsd: usdValue !== null && tokenAmount > 0 ? usdValue / tokenAmount : null,
  };
}

/**
 * Swaps for one token, oldest-first when `order` is 'asc'.
 *
 * Ascending order is what makes launch forensics possible at all. Reaching a
 * token's first trades by paging a wallet or mint history backwards is
 * unbounded — an established token has millions of transactions in front of
 * them — whereas this returns the genesis trades in a single call.
 */
export async function getTokenTrades(
  mint: string,
  opts: { order?: 'asc' | 'desc'; limit?: number; offset?: number } = {}
): Promise<BirdeyeTokenTrade[]> {
  if (!config.birdeye.enabled) return [];
  const { order = 'asc', limit = 50, offset = 0 } = opts;

  const payload = await requestSoft<BirdeyeEnvelope<{ items: RawTokenTrade[] }>>(
    url('/defi/txs/token', {
      address: mint,
      tx_type: 'swap',
      sort_type: order,
      limit: Math.min(limit, 50),
      offset,
    }),
    { headers: headers(), label: 'birdeye-token-trades', timeoutMs: 25_000 },
    { success: false, data: { items: [] } }
  );

  return (payload?.data?.items ?? [])
    .map((raw) => normaliseTrade(raw, mint))
    .filter((t): t is BirdeyeTokenTrade => t !== null);
}

/** Pages ascending trades up to `max`, stopping early when the feed runs out. */
export async function getEarliestTrades(mint: string, max = 200): Promise<BirdeyeTokenTrade[]> {
  const collected: BirdeyeTokenTrade[] = [];
  const pageSize = 50;

  for (let offset = 0; collected.length < max; offset += pageSize) {
    const page = await getTokenTrades(mint, {
      order: 'asc',
      limit: Math.min(pageSize, max - collected.length),
      offset,
    });
    if (!page.length) break;
    collected.push(...page);
    if (page.length < pageSize) break;
  }

  return collected;
}

export interface BirdeyeHolder {
  owner: string;
  uiAmount: number;
}

/** Largest holders by owner. Resolves owners directly, unlike RPC. */
export async function getTokenHolders(mint: string, limit = 50): Promise<BirdeyeHolder[]> {
  if (!config.birdeye.enabled) return [];

  const payload = await requestSoft<
    BirdeyeEnvelope<{ items: Array<{ owner?: string; ui_amount?: number }> }>
  >(
    url('/defi/v3/token/holder', { address: mint, limit: Math.min(limit, 100), offset: 0 }),
    { headers: headers(), label: 'birdeye-token-holders', timeoutMs: 25_000 },
    { success: false, data: { items: [] } }
  );

  return (payload?.data?.items ?? [])
    .filter((h) => h.owner)
    .map((h) => ({ owner: h.owner as string, uiAmount: Number(h.ui_amount) || 0 }));
}

/** OHLCV over an explicit window, for pricing historical trades. */
export async function getOhlcvRange(
  mint: string,
  interval: CandleInterval,
  fromUnix: number,
  toUnix: number
): Promise<OhlcvCandle[]> {
  if (!config.birdeye.enabled) return [];
  const payload = await requestSoft<BirdeyeEnvelope<{ items: OhlcvCandle[] }>>(
    url('/defi/ohlcv', {
      address: mint,
      type: interval,
      time_from: Math.floor(fromUnix),
      time_to: Math.ceil(toUnix),
    }),
    { headers: headers(), label: 'birdeye-ohlcv-range', timeoutMs: 25_000 },
    { success: false, data: { items: [] } }
  );
  return payload?.data?.items ?? [];
}

/**
 * Prices a set of mints *as of arbitrary past moments*.
 *
 * Backfilled trades must be valued at the price when they happened, not today.
 * Using the current price would silently invent a cost basis — a wallet that
 * bought at $0.004 and is now at $0.0008 would be recorded as having entered at
 * today's price and shown as flat, which is worse than reporting nothing.
 *
 * In practice this is cheap. `valueSwapUsd` prefers the quote leg, so almost
 * every trade is priced from SOL or a stablecoin: one well-covered OHLCV series
 * for SOL, and a constant for stables. The meme mint itself is only consulted
 * when a swap has no recognisable quote leg.
 */
export interface HistoricalPrices {
  /** Price at a moment, or null when no candle covers it. */
  priceAt(mint: string, unixSeconds: number): number | null;
  /** Mints we could not build a series for, for honest reporting. */
  missing: string[];
}

/** Candle size that keeps a window inside Birdeye's per-response item cap. */
function intervalForSpan(seconds: number): CandleInterval {
  const hours = seconds / 3600;
  if (hours <= 8) return '1m';
  if (hours <= 72) return '15m';
  if (hours <= 24 * 45) return '1H';
  return '4H';
}

export async function buildHistoricalPrices(
  mints: string[],
  fromUnix: number,
  toUnix: number
): Promise<HistoricalPrices> {
  const series = new Map<string, { times: number[]; closes: number[] }>();
  const missing: string[] = [];

  // Pad the window so a trade at either edge still lands inside a candle.
  const interval = intervalForSpan(Math.max(toUnix - fromUnix, 1));
  const pad = 6 * 3600;

  for (const mint of new Set(mints)) {
    if (STABLE_MINTS.has(mint)) continue; // priced at 1 below

    const candles = await getOhlcvRange(mint, interval, fromUnix - pad, toUnix + pad);
    if (!candles.length) {
      missing.push(mint);
      continue;
    }

    const sorted = [...candles].sort((a, b) => a.unixTime - b.unixTime);
    series.set(mint, {
      times: sorted.map((c) => c.unixTime),
      closes: sorted.map((c) => c.c),
    });
  }

  return {
    missing,
    priceAt(mint: string, unixSeconds: number): number | null {
      if (STABLE_MINTS.has(mint)) return 1;

      const entry = series.get(mint);
      if (!entry || !entry.times.length) return null;

      // Nearest candle by time. Binary search: histories run to thousands of
      // candles and this is called once per trade.
      let lo = 0;
      let hi = entry.times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entry.times[mid] < unixSeconds) lo = mid + 1;
        else hi = mid;
      }
      const after = lo;
      const before = Math.max(lo - 1, 0);
      const pick =
        Math.abs(entry.times[after] - unixSeconds) < Math.abs(entry.times[before] - unixSeconds)
          ? after
          : before;

      // Refuse to price a trade that falls far outside the candles we have —
      // the nearest close could be days away and meaningless.
      const maxGapSeconds = 6 * 3600;
      if (Math.abs(entry.times[pick] - unixSeconds) > maxGapSeconds) return null;

      const close = entry.closes[pick];
      return Number.isFinite(close) && close > 0 ? close : null;
    },
  };
}

/**
 * Approximates when a token began trading, from its earliest OHLCV candle.
 *
 * This exists because pump.fun's public API is the only direct source of launch
 * time and is frequently unreachable (it currently answers HTTP 530), which
 * silently disables snipe detection. The first candle a price feed has for a
 * mint is a close proxy for its first trade.
 *
 * Two passes: hourly candles over a wide window to locate the hour trading
 * started, then minute candles around that hour for the precision snipe
 * detection needs. Returns null when the token already traded before the
 * window opened — i.e. it is not a recent launch, so it cannot be a snipe.
 */
export async function getFirstTradeTime(
  mint: string,
  windowDays = 14
): Promise<Date | null> {
  if (!config.birdeye.enabled) return null;

  const now = Math.floor(Date.now() / 1000);
  const from = now - windowDays * 86400;

  const coarse = await rangeOhlcv(mint, '1H', from, now);
  if (!coarse.length) return null;

  const firstCoarse = coarse[0].unixTime;
  // Trading was already underway when the window opened: not a recent launch.
  if (firstCoarse <= from + 3600) return null;

  const fine = await rangeOhlcv(mint, '1m', firstCoarse - 3600, firstCoarse + 3600);
  const firstTick = fine.length ? fine[0].unixTime : firstCoarse;
  return new Date(firstTick * 1000);
}

/** OHLCV over an explicit time range. */
async function rangeOhlcv(
  mint: string,
  interval: CandleInterval,
  timeFrom: number,
  timeTo: number
): Promise<OhlcvCandle[]> {
  const payload = await requestSoft<BirdeyeEnvelope<{ items: OhlcvCandle[] }>>(
    url('/defi/ohlcv', { address: mint, type: interval, time_from: timeFrom, time_to: timeTo }),
    { headers: headers(), label: 'birdeye-ohlcv-range', timeoutMs: 20_000, retries: 2 },
    { success: false, data: { items: [] } }
  );
  const items = payload?.data?.items ?? [];
  return [...items].sort((a, b) => a.unixTime - b.unixTime);
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
 * Priced wallet holdings in one call — cheaper and richer than RPC balances
 * plus a price lookup, so it is preferred when the plan allows it.
 *
 * Returns `[]` on a plan-restricted key, which `collectPortfolioMetrics` treats
 * as "use the RPC path instead". After the first 401 the endpoint is skipped
 * entirely rather than re-attempted once per wallet.
 */
export async function getWalletPortfolio(wallet: string): Promise<BirdeyeWalletItem[]> {
  if (!config.birdeye.enabled || planRestricted.has('wallet_token_list')) return [];

  try {
    const payload = await request<
      BirdeyeEnvelope<{ wallet: string; totalUsd: number; items: BirdeyeWalletItem[] }>
    >(url('/v1/wallet/token_list', { wallet }), {
      headers: headers(),
      label: 'birdeye-wallet',
      timeoutMs: 20_000,
      retries: 1,
    });
    return payload?.data?.items ?? [];
  } catch (error) {
    if (isPlanRestricted(error)) planRestricted.add('wallet_token_list');
    return [];
  }
}

/** Which paid-plan endpoints this key has been observed to lack. Surfaced by /api/health. */
export function restrictedEndpoints(): string[] {
  return [...planRestricted];
}

export interface BirdeyeTopTrader {
  owner: string;
  tags: string[] | null;
  type: string;
  trade: number;
  tradeBuy: number;
  tradeSell: number;
  /**
   * CAUTION: `volume`, `volumeBuy` and `volumeSell` are denominated in TOKEN
   * units, not USD. Only the `*Usd`/`*USD` fields are dollars. Reading `volume`
   * as USD overstates a wallet's size by the token's price — for a sub-cent
   * meme token that is a factor of thousands.
   */
  volume: number;
  volumeBuy: number;
  volumeSell: number;
  volumeUsd?: number | null;
  volumeBuyUSD?: number | null;
  volumeSellUSD?: number | null;
  /** Birdeye's own PnL attribution for this trader on this token, in USD. */
  totalPnl?: number | null;
  realizedPnl?: number | null;
  unrealizedPnl?: number | null;
}

/** USD volume for a top trader, guarding against the token-unit `volume` field. */
export function topTraderVolumeUsd(trader: BirdeyeTopTrader): number {
  const usd = trader.volumeUsd;
  if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) return usd;
  const buy = trader.volumeBuyUSD ?? 0;
  const sell = trader.volumeSellUSD ?? 0;
  const summed = buy + sell;
  // Never fall back to `volume` — it is token-denominated and would be wrong.
  return Number.isFinite(summed) && summed > 0 ? summed : 0;
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

// --- Profitable traders ------------------------------------------------------

export type TraderWindow = 'today' | 'yesterday' | '1W' | '30d' | '90d';

export interface ProfitableTrader {
  address: string;
  /** Profit actually taken. The only number here worth trusting. */
  realizedPnlUsd: number;
  /** Reported paper gain. Frequently nonsense — see below. */
  unrealizedPnlUsd: number;
  volumeUsd: number;
  tradeCount: number;
}

/**
 * Wallets ranked by profit actually realised.
 *
 * Sorting by headline PnL is worse than useless here. Measured over the top 100
 * for one week: 67 wallets had realised nothing at all, 64 had fewer than ten
 * trades, and the leaders were holding illiquid bags marked at absurd prices —
 * one showed $22M of "profit" on $946 of lifetime volume. Seeding a whale
 * roster from that list fills it with people holding worthless tokens.
 *
 * Sorting by `realized_pnl` returns a different population entirely: wallets
 * with hundreds of trades, real volume, and money actually taken off the table.
 *
 * So unrealised gains are treated as unreliable throughout. A wallet qualifies
 * on money it has actually banked, and the mark-to-market number is only used
 * to *reject* — an implausible ratio of paper gains to volume means the feed's
 * pricing cannot be trusted for that wallet.
 */
export async function getProfitableTraders(
  opts: { window?: TraderWindow; limit?: number; minRealizedUsd?: number; minTrades?: number } = {}
): Promise<ProfitableTrader[]> {
  if (!config.birdeye.enabled) return [];

  const { window = '1W', limit = 100, minRealizedUsd = 5_000, minTrades = 10 } = opts;

  const rows: Array<{
    address?: string;
    realized_pnl?: number;
    unrealized_pnl?: number;
    volume?: number;
    trade_count?: number;
  }> = [];

  // The endpoint caps a page at 50.
  for (let offset = 0; offset < Math.min(limit, 200); offset += 50) {
    const payload = await requestSoft<BirdeyeEnvelope<{ items: typeof rows }>>(
      url('/trader/gainers-losers', {
        type: window,
        sort_by: 'realized_pnl',
        sort_type: 'desc',
        offset,
        limit: 50,
      }),
      { headers: headers(), label: 'birdeye-gainers', timeoutMs: 25_000 },
      { success: false, data: { items: [] } }
    );
    const page = payload?.data?.items ?? [];
    if (!page.length) break;
    rows.push(...page);
    if (page.length < 50) break;
  }

  /** Paper gains larger than this multiple of traded volume are not believable. */
  const MAX_PAPER_TO_VOLUME = 20;

  return rows
    .filter((row) => {
      if (!row.address) return false;
      const realized = row.realized_pnl ?? 0;
      const volume = row.volume ?? 0;
      const trades = row.trade_count ?? 0;

      // Banked profit, on a record long enough not to be luck.
      if (realized < minRealizedUsd || trades < minTrades || volume <= 0) return false;

      // Reject wallets whose paper gains imply a price the feed cannot support.
      const paperRatio = Math.abs(row.unrealized_pnl ?? 0) / volume;
      return paperRatio < MAX_PAPER_TO_VOLUME;
    })
    .map((row) => ({
      address: row.address as string,
      realizedPnlUsd: row.realized_pnl ?? 0,
      unrealizedPnlUsd: row.unrealized_pnl ?? 0,
      volumeUsd: row.volume ?? 0,
      tradeCount: row.trade_count ?? 0,
    }));
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

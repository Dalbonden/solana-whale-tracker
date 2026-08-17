/**
 * Whale detection: who counts as a whale, and how strongly.
 *
 * Scoring is deliberately multi-factor. Portfolio value alone would flag
 * dormant bags and CEX hot wallets; trade size alone would flag arbitrage bots
 * that never hold anything. A tracker worth reading wants wallets that hold
 * size *and* actively rotate meme exposure, so the score blends five signals:
 *
 *   portfolio value   35%   can they move a market
 *   max trade size    25%   do they actually deploy size
 *   trade frequency   20%   are they active right now
 *   meme exposure     15%   is this a meme trader or a DeFi fund
 *   token diversity    5%   rotating across names, not one-token maxi
 *
 * A wallet must clear the portfolio floor and at least one activity signal
 * before the score is even computed — see `evaluateWallet`.
 */

import { config } from '@/lib/config';
import { getWhaleActivityStats } from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import * as helius from '@/lib/providers/helius';
import * as solscan from '@/lib/providers/solscan';
import { NATIVE_SOL, NON_MEME_MINTS } from '@/lib/solana/constants';
import type { WalletMetrics, Whale, WhaleScore, WhaleTier } from '@/types';

import { getTrackedMints } from './meme-filter';

/** Maps a value onto 0..1 across a log-scaled range. */
function logNorm(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  const lo = Math.log10(Math.max(min, 1));
  const hi = Math.log10(max);
  return (Math.log10(value) - lo) / (hi - lo);
}

function linNorm(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

const WEIGHTS = {
  portfolio: 0.35,
  tradeSize: 0.25,
  frequency: 0.2,
  memeExposure: 0.15,
  diversity: 0.05,
} as const;

export function tierForScore(score: number): WhaleTier {
  if (score >= 85) return 'kraken';
  if (score >= 65) return 'whale';
  if (score >= 45) return 'dolphin';
  return 'shrimp';
}

export function scoreWallet(metrics: WalletMetrics): WhaleScore {
  const components = {
    // $50k → 0, $50M → 1
    portfolio: logNorm(metrics.portfolioValueUsd, 50_000, 50_000_000),
    // $5k → 0, $5M → 1
    tradeSize: logNorm(metrics.maxTradeSizeUsd, 5_000, 5_000_000),
    // 2 trades/30d → 0, 150 → 1
    frequency: linNorm(metrics.tradeCount30d, 2, 150),
    memeExposure: Math.min(metrics.memeExposurePct, 1),
    // 1 token → 0, 12 → 1
    diversity: linNorm(metrics.distinctTokens30d, 1, 12),
  };

  const score =
    100 *
    (components.portfolio * WEIGHTS.portfolio +
      components.tradeSize * WEIGHTS.tradeSize +
      components.frequency * WEIGHTS.frequency +
      components.memeExposure * WEIGHTS.memeExposure +
      components.diversity * WEIGHTS.diversity);

  const rounded = Number(score.toFixed(2));
  const reasons: string[] = [];

  const { detection } = config;
  const clearsPortfolio = metrics.portfolioValueUsd >= detection.minPortfolioUsd;
  const clearsTradeSize = metrics.maxTradeSizeUsd >= detection.minTradeUsd;
  const clearsFrequency = metrics.tradeCount30d >= detection.minTrades30d;
  const clearsExposure = metrics.memeExposurePct >= detection.minMemeExposure;

  if (!clearsPortfolio) {
    reasons.push(
      `portfolio $${Math.round(metrics.portfolioValueUsd).toLocaleString()} < $${detection.minPortfolioUsd.toLocaleString()}`
    );
  }
  if (!clearsTradeSize && !clearsFrequency) {
    reasons.push('no qualifying trade size or trade frequency in the last 30 days');
  }
  if (!clearsExposure) {
    reasons.push(
      `meme exposure ${(metrics.memeExposurePct * 100).toFixed(1)}% < ${(detection.minMemeExposure * 100).toFixed(0)}%`
    );
  }
  if (rounded < detection.minScore) {
    reasons.push(`score ${rounded} < ${detection.minScore}`);
  }

  const qualifies =
    clearsPortfolio &&
    clearsExposure &&
    (clearsTradeSize || clearsFrequency) &&
    rounded >= detection.minScore;

  if (qualifies) reasons.push('qualifies');

  return { score: rounded, tier: tierForScore(rounded), qualifies, reasons, components };
}

// ---------------------------------------------------------------------------
// Metric collection
// ---------------------------------------------------------------------------

/**
 * Values a wallet's holdings and splits them into meme vs non-meme.
 *
 * Prefers Birdeye's priced wallet endpoint (one call, includes USD values) and
 * falls back to RPC balances + a batch price lookup when Birdeye is unavailable
 * or returns nothing.
 */
export async function collectPortfolioMetrics(address: string): Promise<{
  totalUsd: number;
  memeUsd: number;
  holdings: Array<{ mint: string; symbol: string | null; amount: number; usdValue: number; priceUsd: number | null; isMeme: boolean }>;
}> {
  const memeMints = await getTrackedMints();
  const holdings: Array<{
    mint: string;
    symbol: string | null;
    amount: number;
    usdValue: number;
    priceUsd: number | null;
    isMeme: boolean;
  }> = [];

  const birdeyeItems = await birdeye.getWalletPortfolio(address);

  if (birdeyeItems.length) {
    for (const item of birdeyeItems) {
      const usdValue = item.valueUsd ?? 0;
      if (usdValue <= 0) continue;
      holdings.push({
        mint: item.address,
        symbol: item.symbol ?? null,
        amount: item.uiAmount ?? 0,
        usdValue,
        priceUsd: item.priceUsd ?? null,
        isMeme: memeMints.has(item.address) && !NON_MEME_MINTS.has(item.address),
      });
    }
  } else {
    const [balances, solBalance] = await Promise.all([
      helius.getTokenBalances(address),
      helius.getSolBalance(address),
    ]);

    const mints = balances.map((balance) => balance.mint);
    if (solBalance > 0) mints.push(NATIVE_SOL);
    const prices = await birdeye.getPrices(mints);

    if (solBalance > 0) {
      const solPrice = prices.get(NATIVE_SOL) ?? 0;
      holdings.push({
        mint: NATIVE_SOL,
        symbol: 'SOL',
        amount: solBalance,
        usdValue: solBalance * solPrice,
        priceUsd: solPrice || null,
        isMeme: false,
      });
    }

    for (const balance of balances) {
      const price = prices.get(balance.mint) ?? 0;
      const usdValue = balance.amount * price;
      if (usdValue <= 0) continue;
      holdings.push({
        mint: balance.mint,
        symbol: null,
        amount: balance.amount,
        usdValue,
        priceUsd: price || null,
        isMeme: memeMints.has(balance.mint) && !NON_MEME_MINTS.has(balance.mint),
      });
    }
  }

  const totalUsd = holdings.reduce((sum, holding) => sum + holding.usdValue, 0);
  const memeUsd = holdings.reduce((sum, holding) => sum + (holding.isMeme ? holding.usdValue : 0), 0);

  return { totalUsd, memeUsd, holdings };
}

/**
 * Builds the full metric set for a wallet.
 *
 * `activityFromDb` is true for wallets we already track (their trade history is
 * stored); false for fresh candidates, whose activity is estimated from the
 * Birdeye top-trader stats that surfaced them.
 */
export async function collectWalletMetrics(
  address: string,
  seed?: { tradeCount?: number; volumeUsd?: number; maxTradeUsd?: number }
): Promise<WalletMetrics> {
  const [portfolio, stats] = await Promise.all([
    collectPortfolioMetrics(address),
    getWhaleActivityStats(address).catch(() => ({
      tradeCount: 0,
      avgUsd: 0,
      maxUsd: 0,
      distinctTokens: 0,
      lastActiveAt: null as Date | null,
    })),
  ]);

  // Stored history wins; seed data fills the gap on first sight.
  const tradeCount = Math.max(stats.tradeCount, seed?.tradeCount ?? 0);
  const seedAvg = seed?.volumeUsd && seed.tradeCount ? seed.volumeUsd / seed.tradeCount : 0;
  const avgTradeSizeUsd = Math.max(stats.avgUsd, seedAvg);
  const maxTradeSizeUsd = Math.max(stats.maxUsd, seed?.maxTradeUsd ?? seedAvg);

  return {
    address,
    portfolioValueUsd: portfolio.totalUsd,
    memeValueUsd: portfolio.memeUsd,
    memeExposurePct: portfolio.totalUsd > 0 ? portfolio.memeUsd / portfolio.totalUsd : 0,
    tradeCount30d: tradeCount,
    avgTradeSizeUsd,
    maxTradeSizeUsd,
    distinctTokens30d: Math.max(stats.distinctTokens, seed?.tradeCount ? 1 : 0),
    realizedPnlUsd: 0,
    winRate: null,
    lastActiveAt: stats.lastActiveAt,
  };
}

/**
 * Full evaluation of a candidate: institutional filter, metrics, score.
 *
 * Exchange and market-maker wallets are excluded outright. They trivially clear
 * every threshold and would drown the list in noise that says nothing about
 * anyone's conviction.
 */
export async function evaluateWallet(
  address: string,
  seed?: { tradeCount?: number; volumeUsd?: number; maxTradeUsd?: number; source?: string }
): Promise<{ metrics: WalletMetrics; score: WhaleScore; whale: Partial<Whale> | null; rejected?: string }> {
  if (await solscan.isInstitutionalAccount(address)) {
    const metrics = await collectWalletMetrics(address, seed);
    return {
      metrics,
      score: {
        score: 0,
        tier: 'shrimp',
        qualifies: false,
        reasons: ['excluded: exchange / market maker / protocol account'],
        components: { portfolio: 0, tradeSize: 0, frequency: 0, memeExposure: 0, diversity: 0 },
      },
      whale: null,
      rejected: 'institutional account',
    };
  }

  const metrics = await collectWalletMetrics(address, seed);
  const score = scoreWallet(metrics);

  if (!score.qualifies) {
    return { metrics, score, whale: null, rejected: score.reasons.join('; ') };
  }

  const label = await solscan.getAccountLabel(address);

  return {
    metrics,
    score,
    whale: {
      address,
      label,
      portfolio_value_usd: Number(metrics.portfolioValueUsd.toFixed(2)),
      meme_value_usd: Number(metrics.memeValueUsd.toFixed(2)),
      meme_exposure_pct: Number(metrics.memeExposurePct.toFixed(4)),
      trade_count_30d: metrics.tradeCount30d,
      avg_trade_size_usd: Number(metrics.avgTradeSizeUsd.toFixed(2)),
      max_trade_size_usd: Number(metrics.maxTradeSizeUsd.toFixed(2)),
      distinct_tokens_30d: metrics.distinctTokens30d,
      score: score.score,
      tier: score.tier,
      discovery_source: seed?.source ?? 'manual',
      is_tracked: true,
      last_active_at: metrics.lastActiveAt?.toISOString() ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate sourcing
// ---------------------------------------------------------------------------

export interface Candidate {
  address: string;
  source: string;
  tradeCount?: number;
  volumeUsd?: number;
  maxTradeUsd?: number;
}

/**
 * Gathers candidate wallets from three angles:
 *
 *   1. Birdeye top traders per tracked meme token — active size, the best signal.
 *   2. Largest token-account holders per mint — big bags that may be dormant.
 *   3. Recent pump.fun graduate top traders — early rotation, before the crowd.
 */
export async function gatherCandidates(
  mints: string[],
  opts: { perToken?: number; includeHolders?: boolean } = {}
): Promise<Candidate[]> {
  const { perToken = 10, includeHolders = true } = opts;
  const { mapWithConcurrency } = await import('@/lib/providers/http');
  const candidates = new Map<string, Candidate>();

  const record = (candidate: Candidate) => {
    const existing = candidates.get(candidate.address);
    if (!existing) {
      candidates.set(candidate.address, candidate);
      return;
    }
    // Keep the strongest observation across tokens.
    existing.tradeCount = Math.max(existing.tradeCount ?? 0, candidate.tradeCount ?? 0);
    existing.volumeUsd = Math.max(existing.volumeUsd ?? 0, candidate.volumeUsd ?? 0);
    existing.maxTradeUsd = Math.max(existing.maxTradeUsd ?? 0, candidate.maxTradeUsd ?? 0);
  };

  await mapWithConcurrency(mints, 3, async (mint) => {
    const traders = await birdeye.getTopTraders(mint, { timeFrame: '24h', limit: perToken });
    for (const trader of traders) {
      if (!trader.owner) continue;
      record({
        address: trader.owner,
        source: 'birdeye_top_traders',
        tradeCount: trader.trade,
        volumeUsd: trader.volume,
        maxTradeUsd: trader.trade > 0 ? trader.volume / trader.trade : trader.volume,
      });
    }
  });

  if (includeHolders) {
    await mapWithConcurrency(mints.slice(0, 12), 2, async (mint) => {
      try {
        const largest = await helius.getLargestTokenAccounts(mint);
        const owners = await helius.getTokenAccountOwners(
          largest.slice(0, 20).map((entry) => entry.address)
        );
        for (const owner of owners) record({ address: owner, source: 'largest_holders' });
      } catch {
        // A single mint failing must not abort discovery.
      }
    });
  }

  return [...candidates.values()];
}

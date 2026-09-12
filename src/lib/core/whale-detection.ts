/**
 * Whale detection: who counts as a whale, and how strongly.
 *
 * Scoring is multi-factor, and weighted towards evidence that a HUMAN is
 * trading rather than a market maker quoting:
 *
 *   average trade size  32%   the cleanest separator in the labelled data
 *   realised profit     30%   money actually banked, not paper gains
 *   concentration       16%   focus on few mints, not breadth across many
 *   portfolio value     12%   can they move a market
 *   meme exposure       10%   a meme trader or a DeFi fund
 *
 * ...then multiplied by a churn penalty for high-count, tiny-size activity.
 *
 * A wallet must clear the portfolio floor and at least one activity signal
 * before the score is even computed — see `evaluateWallet`.
 */

import { config } from '@/lib/config';
import { getWhaleActivityStats } from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import * as helius from '@/lib/providers/helius';
import * as pricing from '@/lib/providers/pricing';
import * as solscan from '@/lib/providers/solscan';
import { NATIVE_SOL, NON_MEME_MINTS } from '@/lib/solana/constants';
import type { WalletMetrics, Whale, WhaleScore, WhaleTier } from '@/types';

import { getTrackedMints } from './meme-filter';
import { computeScore, linNorm, logNorm } from './whale-score';

export function tierForScore(score: number): WhaleTier {
  if (score >= 85) return 'kraken';
  if (score >= 65) return 'whale';
  if (score >= 45) return 'dolphin';
  return 'shrimp';
}

export function scoreWallet(metrics: WalletMetrics): WhaleScore {
  const { score, churnMultiplier, components } = computeScore(metrics);
  const effectiveTradeSize = Math.max(metrics.maxTradeSizeUsd, metrics.avgTradeSizeUsd);

  const rounded = score;
  const reasons: string[] = [];

  const { detection } = config;
  const clearsPortfolio = metrics.portfolioValueUsd >= detection.minPortfolioUsd;
  const clearsTradeSize = effectiveTradeSize >= detection.minTradeUsd;
  const clearsFrequency = metrics.tradeCount30d >= detection.minTrades30d;
  // Satisfied by holdings OR by active trading in the tracked meme universe.
  const clearsExposure =
    metrics.memeExposurePct >= detection.minMemeExposure ||
    metrics.tradeCount30d >= detection.minTrades30d;

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
      `no meme engagement: exposure ${(metrics.memeExposurePct * 100).toFixed(1)}% < ` +
        `${(detection.minMemeExposure * 100).toFixed(0)}% and only ${metrics.tradeCount30d} trades in 30d`
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

  return { score: rounded, tier: tierForScore(rounded), qualifies, reasons, components, churnMultiplier };
}

// ---------------------------------------------------------------------------
// Metric collection
// ---------------------------------------------------------------------------

/**
 * Values a wallet's holdings and splits them into meme vs non-meme.
 *
 * Inventory comes from RPC balances; pricing goes through `pricing`, which
 * quotes Jupiter first and falls back to Birdeye only for critical mints.
 * Birdeye's own priced wallet endpoint is not used — it is plan-gated on this
 * key and returns 401.
 */
export interface Holding {
  mint: string;
  symbol: string | null;
  name: string | null;
  logoUri: string | null;
  amount: number;
  usdValue: number;
  priceUsd: number | null;
  isMeme: boolean;
  /** True when no price source covered this mint, so usdValue is 0 not "worthless". */
  unpriced: boolean;
}

export async function collectPortfolioMetrics(address: string): Promise<{
  totalUsd: number;
  memeUsd: number;
  holdings: Holding[];
}> {
  const memeMints = await getTrackedMints();
  const holdings: Holding[] = [];

  /*
   * Full wallet inventory, not just the tokens we track.
   *
   * Balances come from one RPC call, then Helius DAS `getAssetBatch` resolves
   * every mint to symbol/name/image/price in a single batched request. That is
   * what makes a complete inventory affordable: pricing 124 positions through
   * per-mint Birdeye calls would take minutes on a free key, which is exactly
   * what made discovery time out earlier.
   *
   * Pricing now goes through `pricing`, which quotes 100 mints per keyless
   * Jupiter call. That is cheap enough to price the *whole* inventory rather
   * than a hand-picked subset, so the long tail no longer depends on whatever
   * DAS happens to carry. Birdeye is still the fallback, but only for the mints
   * that drive the score and the trade valuations — SOL, stables and tracked
   * meme tokens — because its budget is metered and, once spent, takes every
   * other Birdeye endpoint down with it.
   *
   * Positions nothing can price are still recorded, with `unpriced: true` and a
   * zero value. They are inventory the wallet genuinely holds; omitting them
   * would misrepresent the portfolio as smaller than it is.
   */
  const [balances, solBalance] = await Promise.all([
    helius.getTokenBalances(address),
    helius.getSolBalance(address),
  ]);

  const allMints = balances.map((balance) => balance.mint);
  const metadata = await helius.getAssetsBatch(allMints);

  // Everything gets a Jupiter quote; only these are worth Birdeye's metered
  // budget when Jupiter has none.
  const criticalMints = allMints.filter(
    (mint) => memeMints.has(mint) || NON_MEME_MINTS.has(mint)
  );
  const mintsToPrice = [...allMints];
  if (solBalance > 0) {
    criticalMints.push(NATIVE_SOL);
    mintsToPrice.push(NATIVE_SOL);
  }
  const prices = await pricing.getPrices(mintsToPrice, { critical: criticalMints });

  const priceFor = (mint: string): number | null =>
    prices.get(mint) ?? metadata.get(mint)?.priceUsd ?? null;

  if (solBalance > 0) {
    const solPrice = priceFor(NATIVE_SOL) ?? 0;
    holdings.push({
      mint: NATIVE_SOL,
      symbol: 'SOL',
      name: 'Solana',
      logoUri: null,
      amount: solBalance,
      usdValue: solBalance * solPrice,
      priceUsd: solPrice || null,
      isMeme: false,
      unpriced: solPrice <= 0,
    });
  }

  for (const balance of balances) {
    const meta = metadata.get(balance.mint);
    const price = priceFor(balance.mint);
    const usdValue = price ? balance.amount * price : 0;

    holdings.push({
      mint: balance.mint,
      symbol: meta?.symbol ?? null,
      name: meta?.name ?? null,
      logoUri: meta?.imageUri ?? null,
      amount: balance.amount,
      usdValue,
      priceUsd: price,
      isMeme: memeMints.has(balance.mint) && !NON_MEME_MINTS.has(balance.mint),
      unpriced: price === null,
    });
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
  seed?: { tradeCount?: number; volumeUsd?: number; avgTradeUsd?: number; realizedPnlUsd?: number }
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
  const seedAvg =
    seed?.avgTradeUsd ??
    (seed?.volumeUsd && seed.tradeCount ? seed.volumeUsd / seed.tradeCount : 0);
  const avgTradeSizeUsd = Math.max(stats.avgUsd, seedAvg);

  /*
   * `maxTradeSizeUsd` is only ever the largest trade we actually parsed and
   * stored. It is deliberately NOT seeded from provider data: the only figure
   * available there is volume/trade-count, which is a mean, and presenting a
   * mean as "largest trade" is simply false — it read as a $66M trade for a
   * wallet holding $814K.
   *
   * The consequence is that a freshly discovered wallet shows 0 here until its
   * first sync. That is honest: we have not observed a trade yet. The scorer
   * falls back to the mean so discovery still works.
   */
  const maxTradeSizeUsd = stats.maxUsd;

  return {
    address,
    portfolioValueUsd: portfolio.totalUsd,
    memeValueUsd: portfolio.memeUsd,
    memeExposurePct: portfolio.totalUsd > 0 ? portfolio.memeUsd / portfolio.totalUsd : 0,
    tradeCount30d: tradeCount,
    avgTradeSizeUsd,
    maxTradeSizeUsd,
    distinctTokens30d: Math.max(stats.distinctTokens, seed?.tradeCount ? 1 : 0),
    realizedPnlUsd: seed?.realizedPnlUsd ?? 0,
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
  seed?: {
    tradeCount?: number;
    volumeUsd?: number;
    avgTradeUsd?: number;
    realizedPnlUsd?: number;
    source?: string;
  }
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
        components: {
          portfolio: 0,
          avgTradeSize: 0,
          tradeSize: 0,
          memeExposure: 0,
          concentration: 0,
          profitability: 0,
        },
        churnMultiplier: 1,
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
      realized_pnl_usd: Number(metrics.realizedPnlUsd.toFixed(2)),
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
  /**
   * Mean USD size of the candidate's observed trades. Explicitly NOT a maximum:
   * it is derived by dividing reported volume by trade count, so it must never
   * be written to `max_trade_size_usd`, which means "largest trade we actually
   * recorded".
   */
  avgTradeUsd?: number;
  /** Birdeye's realised PnL attribution, USD. */
  realizedPnlUsd?: number;
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
    existing.avgTradeUsd = Math.max(existing.avgTradeUsd ?? 0, candidate.avgTradeUsd ?? 0);
    existing.realizedPnlUsd = Math.max(
      existing.realizedPnlUsd ?? 0,
      candidate.realizedPnlUsd ?? 0
    );
  };

  await mapWithConcurrency(mints, 3, async (mint) => {
    const traders = await birdeye.getTopTraders(mint, { timeFrame: '24h', limit: perToken });
    for (const trader of traders) {
      if (!trader.owner) continue;
      // `volumeUsd`, never `volume` — the latter is denominated in token units.
      const volumeUsd = birdeye.topTraderVolumeUsd(trader);
      record({
        address: trader.owner,
        source: 'birdeye_top_traders',
        tradeCount: trader.trade,
        volumeUsd,
        avgTradeUsd: trader.trade > 0 ? volumeUsd / trader.trade : volumeUsd,
        realizedPnlUsd: trader.realizedPnl ?? undefined,
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

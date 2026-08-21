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

/*
 * Weights.
 *
 * `profitability` was added after the roster filled with wallets that trade
 * enormously and lose steadily: six of the first ten classified as
 * "distributing", 78 losing sells against 27 winners, net realised P&L of
 * -$201. Nothing in the original score rewarded making money, so the pipeline
 * optimised for size and churn — and churn correlates with losses.
 *
 * Portfolio and trade size gave up ten points between them to fund it. Being
 * rich is a weaker signal than getting richer: a large balance can be inherited
 * from one lucky position or from a wallet that has been bleeding for months,
 * whereas banked profit is evidence of a repeatable process.
 */
const WEIGHTS = {
  portfolio: 0.28,
  tradeSize: 0.2,
  frequency: 0.17,
  memeExposure: 0.13,
  diversity: 0.05,
  profitability: 0.17,
} as const;

export function tierForScore(score: number): WhaleTier {
  if (score >= 85) return 'kraken';
  if (score >= 65) return 'whale';
  if (score >= 45) return 'dolphin';
  return 'shrimp';
}

export function scoreWallet(metrics: WalletMetrics): WhaleScore {
  /*
   * Largest observed trade, falling back to the mean for wallets we have not
   * synced yet (max is 0 until a trade is actually parsed). Without the
   * fallback every freshly discovered wallet would score 0 on trade size and
   * fail the gate, so discovery could never bootstrap.
   */
  const effectiveTradeSize = Math.max(metrics.maxTradeSizeUsd, metrics.avgTradeSizeUsd);

  /*
   * Meme engagement = holdings exposure OR trading flow.
   *
   * Measuring exposure purely from a point-in-time snapshot systematically
   * penalises the most active meme traders: a wallet that flips memes all day
   * and parks in SOL overnight shows ~1% exposure, while a dormant bag-holder
   * shows 90%. Observed rejections were dominated by this — candidates pulled
   * from a meme-token top-trader list, rejected for "meme exposure 1.4% < 5%".
   *
   * Trading the tracked meme universe is exposure to meme markets, just held as
   * flow rather than inventory, so it counts. Holdings still dominate when they
   * exist; flow only sets a floor, and is capped below 1 so a pure flipper
   * never outscores someone doing both.
   */
  const flowEngagement = linNorm(metrics.tradeCount30d, 5, 120) * 0.7;
  const memeEngagement = Math.min(Math.max(metrics.memeExposurePct, flowEngagement), 1);

  /*
   * Profitability from money actually banked.
   *
   * Realised only — paper gains are not evidence. A wallet is credited from
   * $1k of realised profit and saturates at $1M; losses score zero rather than
   * negative, because an unprofitable wallet may still be worth tracking (a
   * large distributor moves markets regardless of whether it is any good at
   * it), it just should not outrank a profitable one.
   */
  const profitability =
    metrics.realizedPnlUsd > 0 ? logNorm(metrics.realizedPnlUsd, 1_000, 1_000_000) : 0;

  const components = {
    // $50k → 0, $50M → 1
    portfolio: logNorm(metrics.portfolioValueUsd, 50_000, 50_000_000),
    // $5k → 0, $5M → 1
    tradeSize: logNorm(effectiveTradeSize, 5_000, 5_000_000),
    // 2 trades/30d → 0, 150 → 1
    frequency: linNorm(metrics.tradeCount30d, 2, 150),
    memeExposure: memeEngagement,
    // 1 token → 0, 12 → 1
    diversity: linNorm(metrics.distinctTokens30d, 1, 12),
    profitability,
  };

  const score =
    100 *
    (components.portfolio * WEIGHTS.portfolio +
      components.tradeSize * WEIGHTS.tradeSize +
      components.frequency * WEIGHTS.frequency +
      components.memeExposure * WEIGHTS.memeExposure +
      components.diversity * WEIGHTS.diversity +
      components.profitability * WEIGHTS.profitability);

  const rounded = Number(score.toFixed(2));
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
   * Birdeye is still consulted, but only for the mints that must be accurate —
   * SOL, stables and tracked meme tokens — since those drive the score and the
   * trade valuations. DAS prices cover the long tail.
   *
   * Positions DAS cannot price are still recorded, with `unpriced: true` and a
   * zero value. They are inventory the wallet genuinely holds; omitting them
   * would misrepresent the portfolio as smaller than it is.
   */
  const [balances, solBalance] = await Promise.all([
    helius.getTokenBalances(address),
    helius.getSolBalance(address),
  ]);

  const allMints = balances.map((balance) => balance.mint);
  const metadata = await helius.getAssetsBatch(allMints);

  // Accurate pricing only where it matters; DAS covers everything else.
  const priorityMints = allMints.filter(
    (mint) => memeMints.has(mint) || NON_MEME_MINTS.has(mint)
  );
  if (solBalance > 0) priorityMints.push(NATIVE_SOL);
  const prices = await birdeye.getPrices(priorityMints);

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
          tradeSize: 0,
          frequency: 0,
          memeExposure: 0,
          diversity: 0,
          profitability: 0,
        },
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

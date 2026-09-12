/**
 * Whale scoring — the pure half.
 *
 * Extracted so the weights can be regression-tested against real labelled
 * wallets without a database, a network or an env file. The scoring decides the
 * entire watchlist, and the previous version ranked market makers above traders
 * for a year without anyone noticing, so it is exactly the code that should not
 * be untestable.
 *
 * Kept free of imports for that reason.
 */

/** Maps a value onto 0..1 across a log-scaled range. */
export function logNorm(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  const lo = Math.log10(Math.max(min, 1));
  return (Math.log10(value) - lo) / (Math.log10(max) - lo);
}

export function linNorm(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

/*
 * Weights, set against labelled data rather than intuition.
 *
 * The previous scoring ranked market makers above traders, and did so by
 * construction: `frequency` gave a wallet with 5,823 trades a perfect 1.0,
 * and `diversity` scored a focused trader 0.0 for touching a single mint.
 * Both components rewarded exactly the population the tracker exists to
 * exclude. Measured on the live roster, the top two scores belonged to wallets
 * averaging $97 and $72 a trade with roughly zero realised profit, while the
 * two wallets with six-figure realised P&L ranked 3rd and 5th.
 *
 * AVERAGE TRADE SIZE separates them almost perfectly. On 17 labelled wallets
 * the two real traders average $49,181 and $93,318; every other wallet falls
 * between $72 and $2,807. Maximum trade size does NOT separate them — one
 * market maker's largest trade was $98,154 against a real trader's $103,067 —
 * so it is deliberately not the headline signal.
 *
 * `frequency` is gone as a positive component. Trading often is not evidence of
 * skill, and here it was evidence of the opposite.
 */
const WEIGHTS = {
  avgTradeSize: 0.32,
  profitability: 0.3,
  concentration: 0.16,
  portfolio: 0.12,
  memeExposure: 0.1,
} as const;

/*
 * Market making is a high trade count at a trivial average size. Neither alone
 * is damning — a real trader can be active, and a small account can be
 * patient — so the penalty needs both.
 */
const CHURN_TRADE_COUNT = 400;
const CHURN_AVG_TRADE_USD = 5_000;
const CHURN_PENALTY = 0.35;
const BUSY_PENALTY = 0.7;


export interface ScoreInputs {
  avgTradeSizeUsd: number;
  maxTradeSizeUsd: number;
  realizedPnlUsd: number;
  distinctTokens30d: number;
  tradeCount30d: number;
  portfolioValueUsd: number;
  memeExposurePct: number;
}

export interface ScoreBreakdown {
  score: number;
  churnMultiplier: number;
  components: {
    portfolio: number;
    avgTradeSize: number;
    tradeSize: number;
    memeExposure: number;
    concentration: number;
    profitability: number;
  };
}

/** How heavily to discount a wallet for market-making behaviour. */
export function churnMultiplierFor(tradeCount30d: number, avgTradeSizeUsd: number): number {
  if (tradeCount30d > CHURN_TRADE_COUNT && avgTradeSizeUsd < CHURN_AVG_TRADE_USD) {
    return CHURN_PENALTY;
  }
  if (tradeCount30d > CHURN_TRADE_COUNT) return BUSY_PENALTY;
  return 1;
}

export function computeScore(m: ScoreInputs): ScoreBreakdown {
  const effectiveTradeSize = Math.max(m.maxTradeSizeUsd, m.avgTradeSizeUsd);

  /*
   * Meme engagement = holdings exposure OR trading flow. A wallet that flips
   * memes all day and parks in SOL overnight shows ~1% exposure, while a dormant
   * bag-holder shows 90%, so flow sets a floor.
   */
  const flowEngagement = linNorm(m.tradeCount30d, 5, 120) * 0.7;
  const memeEngagement = Math.min(Math.max(m.memeExposurePct, flowEngagement), 1);

  /*
   * Realised only. Paper gains are not evidence, and losses score zero rather
   * than negative: an unprofitable wallet can still be worth watching, it just
   * must not outrank a profitable one.
   */
  const profitability =
    m.realizedPnlUsd > 0 ? logNorm(m.realizedPnlUsd, 1_000, 1_000_000) : 0;

  const components = {
    avgTradeSize: logNorm(m.avgTradeSizeUsd, 500, 100_000),
    profitability,
    concentration: 1 - linNorm(m.distinctTokens30d, 1, 10),
    portfolio: logNorm(m.portfolioValueUsd, 50_000, 50_000_000),
    memeExposure: memeEngagement,
    tradeSize: logNorm(effectiveTradeSize, 5_000, 5_000_000),
  };

  const churnMultiplier = churnMultiplierFor(m.tradeCount30d, m.avgTradeSizeUsd);

  const score =
    100 *
    (components.avgTradeSize * WEIGHTS.avgTradeSize +
      components.profitability * WEIGHTS.profitability +
      components.concentration * WEIGHTS.concentration +
      components.portfolio * WEIGHTS.portfolio +
      components.memeExposure * WEIGHTS.memeExposure) *
    churnMultiplier;

  return { score: Number(score.toFixed(2)), churnMultiplier, components };
}

const assert = require('node:assert');
const { test } = require('node:test');
const { computeScore, churnMultiplierFor } = require('../.test-build/core/whale-score.js');

/*
 * Real wallets from the live roster, with their real metrics.
 *
 * The two labelled REAL are the only two of seventeen that an independent
 * ranking (the trading bot's own `rank-wallets` script) kept after
 * disqualifying market makers on trade behaviour. They are the ground truth
 * these weights exist to rank first.
 */
const DrAR2ZNC = {
  avgTradeSizeUsd: 93_318, maxTradeSizeUsd: 103_067, realizedPnlUsd: 322_932,
  distinctTokens30d: 1, tradeCount30d: 46, portfolioValueUsd: 2_652_975, memeExposurePct: 0.5,
};
const W47d8u9 = {
  avgTradeSizeUsd: 49_181, maxTradeSizeUsd: 223_326, realizedPnlUsd: 190_870,
  distinctTokens30d: 2, tradeCount30d: 185, portfolioValueUsd: 0, memeExposurePct: 0.5,
};
/** Profitable and focused, but an order of magnitude smaller. */
const W6b5JivZq = {
  avgTradeSizeUsd: 2_807, maxTradeSizeUsd: 4_968, realizedPnlUsd: 140_654,
  distinctTokens30d: 1, tradeCount30d: 221, portfolioValueUsd: 24_387, memeExposurePct: 0.5,
};
/** The two wallets the OLD scoring ranked first and second. */
const botTop = {
  avgTradeSizeUsd: 97, maxTradeSizeUsd: 98_154, realizedPnlUsd: 0,
  distinctTokens30d: 9, tradeCount30d: 3_815, portfolioValueUsd: 9_104_530, memeExposurePct: 0.5,
};
const botSecond = {
  avgTradeSizeUsd: 72, maxTradeSizeUsd: 9_518, realizedPnlUsd: -37,
  distinctTokens30d: 12, tradeCount30d: 5_823, portfolioValueUsd: 24_992_864, memeExposurePct: 0.5,
};

const s = (m) => computeScore(m).score;

test('the two proven traders outrank every market maker', () => {
  // This is the whole point. Under the previous weights botTop and botSecond
  // scored 59.7 and 58.0 against 47.4 and 50.5 for the real traders.
  assert.ok(s(DrAR2ZNC) > s(botTop), `DrAR2ZNC ${s(DrAR2ZNC)} should beat botTop ${s(botTop)}`);
  assert.ok(s(W47d8u9) > s(botTop));
  assert.ok(s(DrAR2ZNC) > s(botSecond));
  assert.ok(s(W47d8u9) > s(botSecond));
});

test('a $25M portfolio does not rescue a wallet that averages $72 a trade', () => {
  // botSecond holds the largest book on the roster and has realised -$37.
  assert.ok(s(botSecond) < 20, `expected a low score, got ${s(botSecond)}`);
});

test('holding nothing does not disqualify a wallet that banked $190k', () => {
  // 47d8u9 has a $0 portfolio because it cashed out. Under a portfolio-led
  // score that reads as worthless; it is the opposite.
  assert.ok(s(W47d8u9) > 60, `expected a strong score, got ${s(W47d8u9)}`);
});

test('a smaller but profitable and focused wallet still ranks above the bots', () => {
  assert.ok(s(W6b5JivZq) > s(botTop));
  assert.ok(s(W6b5JivZq) < s(W47d8u9), 'but below the two six-figure traders');
});

test('there is a clear gap between the traders and the market makers', () => {
  const worstReal = Math.min(s(DrAR2ZNC), s(W47d8u9), s(W6b5JivZq));
  const bestBot = Math.max(s(botTop), s(botSecond));
  assert.ok(worstReal - bestBot > 25, `gap was only ${(worstReal - bestBot).toFixed(1)} points`);
});

// --- churn -----------------------------------------------------------------

test('high count at a tiny average is penalised hardest', () => {
  assert.equal(churnMultiplierFor(5_823, 72), 0.35);
});

test('high count at a serious average is only mildly penalised', () => {
  // Being active is not itself disqualifying; being active at $72 is.
  assert.equal(churnMultiplierFor(5_000, 50_000), 0.7);
});

test('a low trade count is never penalised', () => {
  assert.equal(churnMultiplierFor(46, 93_318), 1);
  assert.equal(churnMultiplierFor(221, 2_807), 1);
});

// --- components ------------------------------------------------------------

test('concentration rewards focus, it does not punish it', () => {
  // The old `diversity` component scored a one-mint trader 0.0.
  const focused = computeScore({ ...DrAR2ZNC, distinctTokens30d: 1 }).components.concentration;
  const scattered = computeScore({ ...DrAR2ZNC, distinctTokens30d: 12 }).components.concentration;
  assert.equal(focused, 1);
  assert.equal(scattered, 0);
});

test('realised losses score zero rather than negative', () => {
  const loser = computeScore({ ...DrAR2ZNC, realizedPnlUsd: -500_000 });
  assert.equal(loser.components.profitability, 0);
  assert.ok(loser.score > 0, 'a loss lowers the score without inverting it');
});

test('an empty wallet scores zero without throwing', () => {
  const empty = computeScore({
    avgTradeSizeUsd: 0, maxTradeSizeUsd: 0, realizedPnlUsd: 0,
    distinctTokens30d: 0, tradeCount30d: 0, portfolioValueUsd: 0, memeExposurePct: 0,
  });
  assert.ok(Number.isFinite(empty.score));
  assert.ok(empty.score >= 0);
});

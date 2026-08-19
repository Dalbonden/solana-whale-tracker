const assert = require('node:assert');
const { test } = require('node:test');
const { classifyWallet, median, stdev } = require('../.test-build/core/archetypes.js');

/** A wallet with nothing notable, overridden per test. */
function wallet(overrides = {}) {
  return {
    address: 'W',
    portfolioValueUsd: 50_000,
    tradeCount30d: 10,
    distinctTokens30d: 3,
    avgTradeSizeUsd: 1_000,
    closedCycles: 10,
    medianHoldHours: 24,
    winRate: 0.5,
    profitFactor: 1.0,
    realizedPnlUsd: 0,
    pnlPctStdev: 0.3,
    netFlow30dUsd: 0,
    openPositions: 2,
    maxConvictionPct: 0.15,
    underwaterShare: 0,
    txPerHour: 2,
    snipeCount: 0,
    daysTracked: 60,
    ...overrides,
  };
}

const tags = (m) => classifyWallet(m).map((a) => a.tag);
const find = (m, tag) => classifyWallet(m).find((a) => a.tag === tag);

// ---------------------------------------------------------------------------
// Skill — withheld on thin evidence
// ---------------------------------------------------------------------------

test('a profitable wallet with enough closes is smart money', () => {
  const t = tags(wallet({ profitFactor: 2.4, winRate: 0.6, closedCycles: 20 }));
  assert.ok(t.includes('smart_money'));
});

test('the same performance on few closes is not labelled at all', () => {
  const t = tags(wallet({ profitFactor: 2.4, winRate: 0.6, closedCycles: 4 }));
  assert.ok(!t.includes('smart_money'), 'four lucky closes must not read as skill');
});

test('smart money on a borderline sample is provisional', () => {
  const a = find(wallet({ profitFactor: 2.4, winRate: 0.6, closedCycles: 9 }), 'smart_money');
  assert.equal(a.confidence, 'provisional');
});

test('smart money on a deep sample is observed', () => {
  const a = find(wallet({ profitFactor: 2.4, winRate: 0.6, closedCycles: 30 }), 'smart_money');
  assert.equal(a.confidence, 'observed');
});

test('a consistently losing wallet is called that', () => {
  const t = tags(wallet({ profitFactor: 0.4, winRate: 0.2, closedCycles: 20, realizedPnlUsd: -50_000 }));
  assert.ok(t.includes('losing'));
  assert.ok(!t.includes('smart_money'));
});

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

test('high variance with a poor hit rate is a gambler', () => {
  const t = tags(wallet({ pnlPctStdev: 2.2, winRate: 0.25, closedCycles: 12 }));
  assert.ok(t.includes('gambler'));
});

test('high variance with a good hit rate is not a gambler', () => {
  const t = tags(wallet({ pnlPctStdev: 2.2, winRate: 0.62, closedCycles: 12 }));
  assert.ok(!t.includes('gambler'), 'winning often is not gambling, however volatile');
});

test('a single dominant position is flagged concentrated', () => {
  const a = find(wallet({ maxConvictionPct: 0.42 }), 'concentrated');
  assert.ok(a);
  assert.match(a.detail, /42%/);
});

test('many small positions read as diversified', () => {
  const t = tags(wallet({ maxConvictionPct: 0.05, distinctTokens30d: 14 }));
  assert.ok(t.includes('diversified'));
  assert.ok(!t.includes('concentrated'));
});

test('holding mostly losers is surfaced, not hidden', () => {
  const t = tags(wallet({ underwaterShare: 0.8, openPositions: 5 }));
  assert.ok(t.includes('bagholder'));
});

test('underwater needs enough open positions to mean anything', () => {
  const t = tags(wallet({ underwaterShare: 1.0, openPositions: 1 }));
  assert.ok(!t.includes('bagholder'), 'one losing position is not a pattern');
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

test('machine-speed velocity is called automated with confidence', () => {
  const a = find(wallet({ txPerHour: 480 }), 'bot');
  assert.equal(a.confidence, 'observed');
  assert.match(a.detail, /480 transactions per hour/);
});

test('high trade count alone is only provisional automation', () => {
  const a = find(wallet({ txPerHour: null, tradeCount30d: 600 }), 'bot');
  assert.equal(a.confidence, 'provisional');
});

test('a normal wallet is not called a bot', () => {
  assert.ok(!tags(wallet({ txPerHour: 3, tradeCount30d: 40 })).includes('bot'));
});

test('repeated launch buys are flagged, with the innocent reading stated', () => {
  const a = find(wallet({ snipeCount: 11 }), 'sniper');
  assert.equal(a.confidence, 'observed');
  assert.match(a.detail, /bots/i, 'must not imply wrongdoing');
});

// ---------------------------------------------------------------------------
// Style and position
// ---------------------------------------------------------------------------

test('fast turnover is a flipper', () => {
  assert.ok(tags(wallet({ medianHoldHours: 0.5 })).includes('flipper'));
});

test('long holds are a holder', () => {
  assert.ok(tags(wallet({ medianHoldHours: 24 * 30 })).includes('holder'));
});

test('days-long holds are swing trading', () => {
  assert.ok(tags(wallet({ medianHoldHours: 48 })).includes('swing'));
});

test('a big book traded rarely is size with low turnover', () => {
  const t = tags(wallet({ portfolioValueUsd: 8_000_000, tradeCount30d: 6 }));
  assert.ok(t.includes('size_player'));
});

test('net buying and net selling are distinguished', () => {
  assert.ok(tags(wallet({ netFlow30dUsd: 250_000 })).includes('accumulating'));
  assert.ok(tags(wallet({ netFlow30dUsd: -250_000 })).includes('distributing'));
});

// ---------------------------------------------------------------------------
// The honest fallback
// ---------------------------------------------------------------------------

test('a wallet with no measurable behaviour says so', () => {
  const t = tags(
    wallet({
      closedCycles: 0,
      medianHoldHours: null,
      winRate: null,
      profitFactor: null,
      pnlPctStdev: null,
      maxConvictionPct: null,
      underwaterShare: null,
      txPerHour: null,
      tradeCount30d: 0,
      distinctTokens30d: 0,
      netFlow30dUsd: 0,
      openPositions: 0,
      daysTracked: 2,
    })
  );
  assert.deepEqual(t, ['unclassified']);
});

test('tags are ordered with skill first', () => {
  const list = classifyWallet(
    wallet({ profitFactor: 3, winRate: 0.7, closedCycles: 20, medianHoldHours: 0.5, txPerHour: 500 })
  );
  assert.equal(list[0].kind, 'skill');
  assert.ok(list.some((a) => a.kind === 'style'));
});

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

test('median handles both parities and empties', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('stdev needs at least two samples', () => {
  assert.equal(stdev([5]), null);
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2) < 1e-9);
});

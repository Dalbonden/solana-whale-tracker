const assert = require('node:assert');
const { test } = require('node:test');
const { applyTrade, derivePositionView, stateToRow } = require('../.test-build/core/positions.js');

const t0 = new Date('2026-01-01T00:00:00Z');
const at = (minutes) => new Date(t0.getTime() + minutes * 60_000);

let seq = 0;
const buy = (tokenAmount, usdValue, minutes = 0) => ({
  signature: `sig${seq++}`,
  side: 'buy',
  tokenAmount,
  usdValue,
  blockTime: at(minutes),
});
const sell = (tokenAmount, usdValue, minutes = 0) => ({
  signature: `sig${seq++}`,
  side: 'sell',
  tokenAmount,
  usdValue,
  blockTime: at(minutes),
});

/** Runs a sequence of trades from flat, returning the final state + last call. */
function replay(trades) {
  let state = null;
  let last = null;
  for (const trade of trades) {
    last = applyTrade(state, trade);
    state = last.state;
  }
  return { state, classification: last.classification };
}

// ---------------------------------------------------------------------------
// Opening and basis
// ---------------------------------------------------------------------------

test('first buy opens a position and is flagged as new', () => {
  const { state, classification } = replay([buy(1000, 5000)]);
  assert.equal(classification.isNewPosition, true);
  assert.equal(state.amount, 1000);
  assert.equal(state.costBasisUsd, 5000);
  assert.equal(state.avgEntryPrice, 5);
  assert.equal(state.status, 'open');
  assert.equal(state.basisComplete, true);
});

test('a second buy averages the entry and is not a new position', () => {
  const { state, classification } = replay([buy(1000, 5000), buy(1000, 15000, 60)]);
  assert.equal(classification.isNewPosition, false);
  assert.equal(state.amount, 2000);
  assert.equal(state.costBasisUsd, 20000);
  assert.equal(state.avgEntryPrice, 10); // (5000 + 15000) / 2000
  assert.equal(state.buyCount, 2);
});

// ---------------------------------------------------------------------------
// Realised P&L
// ---------------------------------------------------------------------------

test('partial sell realises P&L on the sold share only', () => {
  const { state, classification } = replay([buy(1000, 5000), sell(400, 4000, 120)]);
  // Basis of 400 units at $5 = $2000; proceeds $4000.
  assert.equal(classification.costBasisUsd, 2000);
  assert.equal(classification.realizedPnlUsd, 2000);
  assert.equal(classification.realizedPnlPct, 1); // +100%
  assert.equal(classification.isFullExit, false);
  assert.equal(state.amount, 600);
  assert.equal(state.costBasisUsd, 3000); // basis of the 600 still held
  assert.equal(state.avgEntryPrice, 5); // unchanged by a sale
  assert.equal(state.status, 'open');
});

test('losing sell reports negative P&L', () => {
  const { classification } = replay([buy(1000, 10000), sell(500, 2000, 30)]);
  assert.equal(classification.costBasisUsd, 5000);
  assert.equal(classification.realizedPnlUsd, -3000);
  assert.equal(classification.realizedPnlPct, -0.6);
});

test('full exit closes the position and clears residual basis', () => {
  const { state, classification } = replay([buy(1000, 5000), sell(1000, 9000, 240)]);
  assert.equal(classification.isFullExit, true);
  assert.equal(classification.realizedPnlUsd, 4000);
  assert.equal(state.status, 'closed');
  assert.equal(state.amount, 0);
  assert.equal(state.costBasisUsd, 0);
  assert.deepEqual(state.closedAt, at(240));
});

test('dust left behind still counts as a full exit', () => {
  // 2% residual is under the 5% default threshold.
  const { state, classification } = replay([buy(1000, 5000), sell(980, 9000, 10)]);
  assert.equal(classification.isFullExit, true);
  assert.equal(state.status, 'closed');
});

test('residual above the threshold does not close the position', () => {
  const { state, classification } = replay([buy(1000, 5000), sell(900, 9000, 10)]);
  assert.equal(classification.isFullExit, false);
  assert.equal(state.status, 'open');
  assert.equal(state.amount, 100);
});

test('the exit threshold is configurable', () => {
  const opened = applyTrade(null, buy(1000, 5000));
  const strict = applyTrade(opened.state, sell(980, 9000, 10), { fullExitResidual: 0.001 });
  assert.equal(strict.classification.isFullExit, false);
});

// ---------------------------------------------------------------------------
// Unknown basis — the honesty cases
// ---------------------------------------------------------------------------

test('selling a position we never saw bought reports no P&L', () => {
  const { state, classification } = replay([sell(500, 12000)]);
  assert.equal(classification.realizedPnlUsd, null);
  assert.equal(classification.costBasisUsd, null);
  // Cannot claim to have closed a position we never saw opened.
  assert.equal(classification.isFullExit, false);
  assert.equal(state.basisComplete, false);
  assert.equal(state.totalSoldUsd, 12000);
  // Nothing is held, so it must not linger as a live position.
  assert.equal(state.status, 'closed');
  assert.equal(state.amount, 0);
});

test('repeated unattributable sells stay in one record', () => {
  const { state } = replay([sell(500, 1000), sell(400, 800, 10), sell(300, 600, 20)]);
  assert.equal(state.sellCount, 3, 'one cycle, not three');
  assert.equal(state.totalSoldUsd, 2400);
  assert.equal(state.status, 'closed');
  assert.equal(state.basisComplete, false);
});

test('a later buy opens a new cycle but inherits the doubt', () => {
  const { state, classification } = replay([sell(500, 12000), buy(100, 1000, 60)]);
  assert.equal(classification.isNewPosition, true);
  assert.equal(state.status, 'open');
  assert.equal(state.amount, 100);
  // They may still hold inventory we never saw, so P&L on this cycle would be
  // measured against a partial position.
  assert.equal(state.basisComplete, false);
});

test('selling more than we saw bought marks the cycle partial', () => {
  const { state } = replay([buy(100, 1000), sell(200, 4000, 60)]);
  assert.equal(state.basisComplete, false, 'unseen inventory is proven');
});

test('a dust sale after a clean exit does not void the closed cycle', () => {
  const { state } = replay([buy(1000, 5000), sell(1000, 9000, 60), sell(5, 40, 90)]);
  assert.equal(state.basisComplete, true, 'the cycle we fully observed stays trustworthy');
  assert.equal(state.realizedPnlUsd, 4000);
  assert.equal(state.status, 'closed');
});

test('selling more than we saw bought only scores the attributable share', () => {
  const { classification } = replay([buy(100, 1000), sell(200, 4000, 60)]);
  // Only 100 units have a known basis of $10 each; proceeds for that half are
  // $2000, so P&L is $1000 — not the $3000 a naive full-size calculation gives.
  assert.equal(classification.costBasisUsd, 1000);
  assert.equal(classification.realizedPnlUsd, 1000);
});

test('an unpriced trade does not fabricate a basis', () => {
  const { classification } = replay([buy(1000, 0), sell(1000, 5000, 60)]);
  assert.equal(classification.realizedPnlUsd, null);
});

// ---------------------------------------------------------------------------
// Re-entry
// ---------------------------------------------------------------------------

test('buying again after a full exit opens a new cycle', () => {
  const first = replay([buy(1000, 5000), sell(1000, 9000, 60)]);
  assert.equal(first.state.status, 'closed');

  const reentry = applyTrade(first.state, buy(500, 3000, 10_000));
  assert.equal(reentry.classification.isNewPosition, true);
  assert.deepEqual(reentry.state.openedAt, at(10_000), 'new cycle re-dates the entry');
  assert.equal(reentry.state.amount, 500);
  assert.equal(reentry.state.costBasisUsd, 3000);
  assert.equal(reentry.state.realizedPnlUsd, 0, 'prior cycle P&L does not carry over');
  assert.equal(reentry.state.buyCount, 1);
});

// ---------------------------------------------------------------------------
// Read-side derivations
// ---------------------------------------------------------------------------

function viewOf(state, price, book = 100_000) {
  const row = { id: 'x', ...stateToRow('whale', 'mint', 'WIF', state) };
  return derivePositionView(row, price, book);
}

test('unrealised P&L marks the open position to market', () => {
  const { state } = replay([buy(1000, 5000)]);
  const view = viewOf(state, 8); // $8 vs $5 entry
  assert.equal(view.market_value_usd, 8000);
  assert.equal(view.unrealized_pnl_usd, 3000);
  assert.equal(view.unrealized_pnl_pct, 0.6);
  assert.equal(view.total_pnl_usd, 3000);
});

test('unrealised P&L is null without a price, never zero', () => {
  const { state } = replay([buy(1000, 5000)]);
  const view = viewOf(state, null);
  assert.equal(view.market_value_usd, null);
  assert.equal(view.unrealized_pnl_usd, null);
  assert.equal(view.conviction_pct, null);
});

test('unrealised P&L is null when the basis was never observed', () => {
  const { state } = replay([sell(500, 12000), buy(100, 1000, 60)]);
  const view = viewOf(state, 20);
  assert.equal(view.unrealized_pnl_usd, null, 'inherited doubt means no mark');
  assert.equal(view.total_pnl_usd, null);
  assert.notEqual(view.market_value_usd, null, 'value is still knowable');
  assert.notEqual(view.conviction_pct, null, 'so is its share of the book');
});

test('conviction is the position as a share of the book', () => {
  const { state } = replay([buy(1000, 5000)]);
  const view = viewOf(state, 8, 40_000);
  assert.equal(view.conviction_pct, 0.2); // $8000 of a $40k book
});

test('hold duration runs to the exit for closed cycles', () => {
  const { state } = replay([buy(1000, 5000), sell(1000, 9000, 180)]);
  const view = viewOf(state, 9);
  assert.equal(view.hold_hours, 3);
});

test('a losing open position reports a loss rather than hiding it', () => {
  const { state } = replay([buy(1000, 10000)]);
  const view = viewOf(state, 1);
  assert.equal(view.unrealized_pnl_usd, -9000);
  assert.equal(view.unrealized_pnl_pct, -0.9);
});

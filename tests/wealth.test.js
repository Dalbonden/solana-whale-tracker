const assert = require('node:assert');
const { test } = require('node:test');
const {
  computeTrajectory,
  classifyWealth,
  relativeGrowth,
  attributionNote,
  medianOf,
} = require('../.test-build/core/wealth.js');

const H = 3600;
/** Snapshots at hourly offsets from an arbitrary epoch. */
const snaps = (...pairs) => pairs.map(([hoursAgo, usd]) => ({ at: 1_700_000_000 - hoursAgo * H, totalUsd: usd }));

// ---------------------------------------------------------------------------
// Sufficiency — the guard that stops noise looking authoritative
// ---------------------------------------------------------------------------

test('a single snapshot is not a trajectory', () => {
  const t = computeTrajectory(snaps([0, 100_000]));
  assert.equal(t.sufficient, false);
  assert.equal(t.changePct, null);
  assert.match(t.shortfall, /1 snapshot/);
});

test('two snapshots twelve hours apart are still not enough', () => {
  // This is exactly the state the live database was in when this was written.
  const t = computeTrajectory(snaps([12, 100_000], [0, 130_000]));
  assert.equal(t.sufficient, false);
  assert.match(t.shortfall, /more history/);
  assert.equal(t.points, 2);
});

test('the shortfall names what is missing', () => {
  const t = computeTrajectory(snaps([2, 100_000], [0, 110_000]));
  assert.match(t.shortfall, /snapshot/);
  assert.match(t.shortfall, /22h more history/);
});

test('three snapshots over more than a day qualify', () => {
  const t = computeTrajectory(snaps([48, 100_000], [24, 110_000], [0, 125_000]));
  assert.equal(t.sufficient, true);
  assert.equal(t.shortfall, null);
  assert.equal(t.changeUsd, 25_000);
  assert.equal(t.changePct, 0.25);
  assert.equal(t.spanHours, 48);
});

test('snapshots are ordered before measuring', () => {
  const t = computeTrajectory(snaps([0, 125_000], [48, 100_000], [24, 110_000]));
  assert.equal(t.earliestUsd, 100_000);
  assert.equal(t.latestUsd, 125_000);
});

// ---------------------------------------------------------------------------
// Beta — growth is only growth if it beats the cohort
// ---------------------------------------------------------------------------

test('growing with the market is tracking, not compounding', () => {
  const t = computeTrajectory(snaps([48, 100_000], [24, 110_000], [0, 120_000]));
  // Up 20%, but so was everyone else.
  assert.equal(classifyWealth(t, 0.2), 'tracking');
});

test('outgrowing the cohort is compounding', () => {
  const t = computeTrajectory(snaps([48, 100_000], [24, 110_000], [0, 140_000]));
  assert.equal(classifyWealth(t, 0.2), 'compounding');
});

test('growing while the cohort grows faster is bleeding', () => {
  const t = computeTrajectory(snaps([48, 100_000], [24, 102_000], [0, 105_000]));
  // Up 5% in a market that did 30% — losing ground.
  assert.equal(classifyWealth(t, 0.3), 'bleeding');
});

test('falling with a falling market is still only tracking', () => {
  const t = computeTrajectory(snaps([48, 100_000], [24, 80_000], [0, 70_000]));
  assert.equal(classifyWealth(t, -0.3), 'tracking');
});

test('insufficient history never produces a verdict', () => {
  const t = computeTrajectory(snaps([12, 100_000], [0, 300_000]));
  assert.equal(classifyWealth(t, 0), 'insufficient');
});

test('relative growth is reported in percentage points', () => {
  assert.equal(relativeGrowth(0.25, 0.1), 15);
  assert.equal(relativeGrowth(null, 0.1), null);
  assert.equal(relativeGrowth(0.25, null), null);
});

// ---------------------------------------------------------------------------
// Deposits — the confound that would most easily mislead
// ---------------------------------------------------------------------------

test('a balance jump trading cannot explain is flagged as deposits', () => {
  assert.match(attributionNote(400_000, 2_000, 0.8), /deposits/);
});

test('a balance drop trading cannot explain is flagged as withdrawals', () => {
  assert.match(attributionNote(-400_000, -2_000, 0.8), /withdrawals/);
});

test('growth that trading accounts for is not flagged', () => {
  assert.equal(attributionNote(50_000, 46_000, 0.8), null);
});

test('small unexplained amounts are not flagged', () => {
  assert.equal(attributionNote(900, 100, 0.8), null, 'sub-$1k noise is not a transfer story');
});

test('missing inputs produce no claim', () => {
  assert.equal(attributionNote(null, 100, 0.8), null);
  assert.equal(attributionNote(100, null, 0.8), null);
});

test('low coverage refuses to explain instead of blaming transfers', () => {
  // The failure this replaced: a $21M book with a few tracked meme positions
  // was labelled "transfers, not performance" on every single row.
  const note = attributionNote(2_500_000, -4, 0.004);
  assert.match(note, /0\.4% of this wallet/);
  assert.doesNotMatch(note, /deposits/);
});

test('coverage high enough to compare still names transfers', () => {
  assert.match(attributionNote(2_500_000, -4, 0.6), /deposits/);
});

// ---------------------------------------------------------------------------
// Cohort median
// ---------------------------------------------------------------------------

test('median ignores nulls and handles both parities', () => {
  assert.equal(medianOf([0.1, null, 0.3, 0.2]), 0.2);
  assert.equal(medianOf([0.1, 0.3]), 0.2);
  assert.equal(medianOf([null, null]), null);
  assert.equal(medianOf([]), null);
});

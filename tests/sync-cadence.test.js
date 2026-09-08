const assert = require('node:assert');
const { test } = require('node:test');
const {
  tierFor,
  isDue,
  msUntilDue,
  selectDueWhales,
  cadenceBreakdown,
} = require('../.test-build/core/sync-cadence.js');

const NOW = Date.parse('2026-09-08T12:00:00Z');
const agoHours = (h) => new Date(NOW - h * 3600_000).toISOString();

// `??` would swallow an explicit null, which is exactly the case under test.
const pick = (over, key, fallback) => (key in over ? over[key] : fallback);

const whale = (over = {}) => ({
  address: pick(over, 'address', 'W1'),
  last_active_at: pick(over, 'last_active_at', agoHours(1)),
  last_synced_at: pick(over, 'last_synced_at', agoHours(1)),
});

test('recent traders land in the fast tier', () => {
  assert.equal(tierFor(agoHours(1), NOW).label, 'hot');
  assert.equal(tierFor(agoHours(1), NOW).everyMinutes, 15);
});

test('the interval widens as activity ages', () => {
  assert.equal(tierFor(agoHours(24), NOW).label, 'active');
  assert.equal(tierFor(agoHours(72), NOW).label, 'slow');
  assert.equal(tierFor(agoHours(24 * 30), NOW).label, 'dormant');
});

test('unknown activity is treated as dormant, not as hot', () => {
  // Guessing "poll often" for a missing timestamp reintroduces the bug this
  // module exists to fix.
  assert.equal(tierFor(null, NOW).label, 'dormant');
  assert.equal(tierFor('not a date', NOW).label, 'dormant');
});

test('a wallet never polled is always due', () => {
  const w = whale({ last_synced_at: null, last_active_at: null });
  assert.equal(isDue(w, NOW), true, 'a newly discovered whale must not wait');
});

test('a hot wallet polled 20 minutes ago is due; a dormant one is not', () => {
  const hot = whale({ last_active_at: agoHours(1), last_synced_at: agoHours(0.34) });
  const dormant = whale({ last_active_at: agoHours(24 * 30), last_synced_at: agoHours(0.34) });
  assert.equal(isDue(hot, NOW), true);
  assert.equal(isDue(dormant, NOW), false);
});

test('a dormant wallet still gets polled eventually', () => {
  const stale = whale({ last_active_at: agoHours(24 * 30), last_synced_at: agoHours(13) });
  assert.equal(isDue(stale, NOW), true, 'dormant is 12-hourly, not never');
});

test('nothing due returns an empty batch rather than filling the quota', () => {
  // The core saving: the old query always returned a full batch because
  // something is always the least-recently-synced.
  const quiet = [
    whale({ address: 'A', last_active_at: agoHours(24 * 30), last_synced_at: agoHours(0.1) }),
    whale({ address: 'B', last_active_at: agoHours(24 * 10), last_synced_at: agoHours(0.1) }),
  ];
  assert.deepEqual(selectDueWhales(quiet, NOW, 25), []);
});

test('the most overdue wallet is polled first', () => {
  const list = [
    whale({ address: 'recent', last_synced_at: agoHours(0.3) }),
    whale({ address: 'stalest', last_synced_at: agoHours(9) }),
    whale({ address: 'middle', last_synced_at: agoHours(2) }),
  ];
  const order = selectDueWhales(list, NOW, 10).map((w) => w.address);
  assert.deepEqual(order, ['stalest', 'middle', 'recent']);
});

test('the batch limit is respected', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    whale({ address: `W${i}`, last_synced_at: agoHours(9) })
  );
  assert.equal(selectDueWhales(many, NOW, 25).length, 25);
  assert.equal(selectDueWhales(many, NOW, 0).length, 0);
});

test('overdue wallets sort ahead of not-yet-due ones by margin', () => {
  const a = whale({ address: 'a', last_synced_at: agoHours(1) });
  const b = whale({ address: 'b', last_synced_at: agoHours(5) });
  assert.ok(msUntilDue(b, NOW) < msUntilDue(a, NOW));
});

test('breakdown counts every wallet exactly once', () => {
  const roster = [
    whale({ last_active_at: agoHours(1) }),
    whale({ last_active_at: agoHours(30) }),
    whale({ last_active_at: agoHours(24 * 30) }),
    whale({ last_active_at: null }),
  ];
  const counts = cadenceBreakdown(roster, NOW);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 4);
  assert.equal(counts.dormant, 2, 'null activity counts as dormant');
});

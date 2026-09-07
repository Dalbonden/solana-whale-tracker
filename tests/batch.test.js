const assert = require('node:assert');
const { test } = require('node:test');
const { planBatches, MAX_IDS_PER_CALL, MAX_QUERY_CHARS } = require('../.test-build/providers/batch.js');

/** Base58 mints are 43-44 chars; this stands in for one. */
const mint = (n) => String(n).padStart(44, 'M');

test('a small list is a single batch', () => {
  const batches = planBatches([mint(1), mint(2), mint(3)]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
});

test('splits at the item cap', () => {
  const ids = Array.from({ length: 250 }, (_, i) => mint(i));
  const batches = planBatches(ids, 100, 1_000_000);
  assert.deepEqual(
    batches.map((b) => b.length),
    [100, 100, 50]
  );
});

test('splits on the character budget before the item cap', () => {
  // 44-char ids: 20 of them plus separators is 899 chars, so a 500-char budget
  // must cut well before the 100-item cap.
  const ids = Array.from({ length: 20 }, (_, i) => mint(i));
  const batches = planBatches(ids, 100, 500);
  assert.ok(batches.length > 1, 'expected the char budget to force a split');
  for (const batch of batches) {
    assert.ok(batch.join(',').length <= 500, `batch of ${batch.join(',').length} chars exceeds budget`);
  }
});

test('every id survives the split, in order', () => {
  const ids = Array.from({ length: 237 }, (_, i) => mint(i));
  const flat = planBatches(ids).flat();
  assert.deepEqual(flat, ids, 'ids must round-trip unchanged');
});

test('real mint widths fit 100 per call under the default budget', () => {
  // The measured case: 100 base58 mints joined is ~4,487 chars, which must not
  // trigger a char-budget split, or every batch call silently halves in size.
  const ids = Array.from({ length: 100 }, (_, i) => mint(i));
  const batches = planBatches(ids);
  assert.equal(batches.length, 1);
  assert.ok(batches[0].join(',').length < MAX_QUERY_CHARS);
});

test('defaults match the measured API limits', () => {
  assert.equal(MAX_IDS_PER_CALL, 100);
  // 200 mints (~9,000 chars) returned 414 against the live endpoint; the budget
  // has to stay comfortably below that.
  assert.ok(MAX_QUERY_CHARS < 9_000);
});

test('an empty list produces no requests', () => {
  assert.deepEqual(planBatches([]), []);
});

test('blank ids are dropped rather than sent as empty query terms', () => {
  // An empty id would produce a trailing comma and a 400 from the server.
  const batches = planBatches(['', mint(1), '', mint(2)]);
  assert.deepEqual(batches, [[mint(1), mint(2)]]);
});

test('an id longer than the whole budget still gets sent, alone', () => {
  // Dropping it would silently lose a mint from the result; a 414 is the
  // honest failure.
  const huge = 'X'.repeat(200);
  const batches = planBatches([mint(1), huge, mint(2)], 100, 100);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[1], [huge]);
});

test('a batch never exceeds both budgets at once', () => {
  const ids = Array.from({ length: 500 }, (_, i) => mint(i));
  for (const batch of planBatches(ids)) {
    assert.ok(batch.length <= MAX_IDS_PER_CALL);
    assert.ok(batch.join(',').length <= MAX_QUERY_CHARS);
  }
});

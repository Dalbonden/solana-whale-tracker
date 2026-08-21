const assert = require('node:assert');
const { test } = require('node:test');
const { selectAllPages, PAGE_SIZE } = require('../.test-build/db/paginate.js');

/**
 * A fake pager over `total` rows that honours the server's behaviour: it never
 * returns more than PAGE_SIZE, whatever range is asked for.
 */
function pagerOver(total, log = []) {
  return (from, to) => {
    log.push([from, to]);
    const end = Math.min(to + 1, total, from + PAGE_SIZE);
    const data = [];
    for (let i = from; i < end; i += 1) data.push({ i });
    return Promise.resolve({ data, error: null });
  };
}

test('a short first page is the whole result', async () => {
  const log = [];
  const rows = await selectAllPages('t', pagerOver(3, log));
  assert.equal(rows.length, 3);
  assert.equal(log.length, 1, 'no second request when the first page is short');
});

test('reads past the server cap that a plain select would hit', async () => {
  // The case this exists for: 2747 rows behind a 1000-row ceiling.
  const rows = await selectAllPages('t', pagerOver(2747));
  assert.equal(rows.length, 2747);
});

test('rows come back in page order with none lost or duplicated', async () => {
  const rows = await selectAllPages('t', pagerOver(2500));
  assert.deepEqual(
    rows.map((r) => r.i).slice(0, 3),
    [0, 1, 2]
  );
  assert.equal(rows[rows.length - 1].i, 2499);
  assert.equal(new Set(rows.map((r) => r.i)).size, 2500, 'no duplicates across pages');
});

test('requests use inclusive ranges that do not overlap', async () => {
  const log = [];
  await selectAllPages('t', pagerOver(2001, log));
  assert.deepEqual(log[0], [0, PAGE_SIZE - 1]);
  assert.deepEqual(log[1], [PAGE_SIZE, PAGE_SIZE * 2 - 1]);
  assert.equal(log[1][0], log[0][1] + 1, 'second page starts right after the first ends');
});

test('an exact multiple of the page size costs one extra empty request', async () => {
  const log = [];
  const rows = await selectAllPages('t', pagerOver(PAGE_SIZE, log));
  assert.equal(rows.length, PAGE_SIZE);
  assert.equal(log.length, 2, 'a full page is indistinguishable from more rows until asked');
});

test('an empty table returns nothing rather than looping', async () => {
  const log = [];
  const rows = await selectAllPages('t', pagerOver(0, log));
  assert.deepEqual(rows, []);
  assert.equal(log.length, 1);
});

test('a null data payload is treated as empty, not as a crash', async () => {
  const rows = await selectAllPages('t', () => Promise.resolve({ data: null, error: null }));
  assert.deepEqual(rows, []);
});

test('an error is raised with the label, not swallowed into a short read', async () => {
  // The failure mode being guarded against: an error that returns [] looks
  // exactly like a table with no matching rows.
  await assert.rejects(
    () => selectAllPages('myQuery', () => Promise.resolve({ data: null, error: { message: 'boom' } })),
    /myQuery: boom/
  );
});

test('an error on a later page fails rather than returning a partial result', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      selectAllPages('later', (from, to) => {
        calls += 1;
        if (calls === 1) return pagerOver(5000)(from, to);
        return Promise.resolve({ data: null, error: { message: 'rate limited' } });
      }),
    /later: rate limited/
  );
});

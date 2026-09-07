/**
 * Splits id lists into request batches that fit inside a URL.
 *
 * Jupiter's batch endpoints take their ids in the query string, so the real
 * limit is the length of the URL rather than a documented item count. Measured
 * against the live API: 100 mints (~4,500 characters of ids) returns 200, while
 * 200 mints returns 414 with no body — the same shape of failure as the
 * PostgREST row cap, in that a naive caller reads it as "these tokens have no
 * data" rather than "the request was too long".
 *
 * Batching therefore has to respect both a count and a character budget, which
 * is fiddly enough to be worth testing without a network. Kept free of imports
 * for that reason.
 */

/** Ids per request. Both Jupiter batch endpoints accept 100. */
export const MAX_IDS_PER_CALL = 100;

/**
 * Character budget for the joined id list. 100 base58 mints measure ~4,487
 * characters; the headroom here leaves room for the rest of the query string
 * while staying far below the ~9,000 that produced a 414.
 */
export const MAX_QUERY_CHARS = 4_600;

/**
 * Groups `ids` into batches within both budgets, preserving order.
 *
 * An id longer than `maxChars` still gets its own batch rather than being
 * dropped: a request that might 414 is a better failure than silently losing a
 * mint from the result set.
 */
export function planBatches(
  ids: readonly string[],
  maxCount: number = MAX_IDS_PER_CALL,
  maxChars: number = MAX_QUERY_CHARS
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const id of ids) {
    if (!id) continue;

    // Cost of appending to the batch being built, including the separator.
    const appended = current.length === 0 ? id.length : chars + 1 + id.length;

    if (current.length > 0 && (current.length >= maxCount || appended > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    chars = current.length === 0 ? id.length : chars + 1 + id.length;
    current.push(id);
  }

  if (current.length) batches.push(current);
  return batches;
}

/**
 * Reads every matching row, not the first page of them.
 *
 * PostgREST caps a response at 1000 rows and returns them without complaint.
 * The cap is enforced server-side, so it cannot be raised from the client:
 * measured against a 2747-row table, an unbounded select returns 1000,
 * `limit=5000` returns 1000, and even a `Range: 0-2999` header returns 1000.
 * Successive `.range()` requests are the only way through.
 *
 * That default is dangerous here because truncation is indistinguishable from
 * missing data. A wallet with four days of snapshots comes back with one, and
 * everything downstream is confidently wrong about how much history exists —
 * which is exactly how the compounders board came to report that none of
 * twelve wallets had enough data when eight of them did.
 *
 * Kept free of imports so it can be unit-tested without a database.
 */

export const PAGE_SIZE = 1000;

export interface PageResult {
  data: unknown;
  error: { message: string } | null;
}

export async function selectAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult>
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);

    const batch = (data ?? []) as T[];
    rows.push(...batch);

    // A short page means the end. A full page might be the end exactly on the
    // boundary, which costs one extra empty request — cheaper than the
    // alternative of guessing and silently dropping rows.
    if (batch.length < PAGE_SIZE) break;
  }

  return rows;
}

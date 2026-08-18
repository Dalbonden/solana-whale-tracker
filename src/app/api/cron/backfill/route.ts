import { authorizeJob, runJob } from '@/lib/api';
import { backfillWhales } from '@/lib/core/backfill';
import { getWhale, getWhalesToBackfill } from '@/lib/db/repositories';
import type { Whale } from '@/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/backfill — walks whale history backwards.
 *
 * The tracker only sees a wallet from the day it was discovered, which leaves
 * most positions with a known sell and an unknown entry. This job reaches back
 * for the missing buys and prices them at the time they happened.
 *
 * Resumable and bounded: each pass covers `BACKFILL_TX_PER_WHALE` transactions
 * per whale and advances a cursor, so running it repeatedly keeps reaching
 * further back without redoing work. Whales are marked complete once Helius has
 * nothing older.
 *
 * `?address=` backfills one wallet; `?max=` overrides the per-whale depth.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const single = url.searchParams.get('address');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 5, 25);
  const maxTransactions = Math.min(Number(url.searchParams.get('max')) || 0, 1000) || undefined;

  return runJob('cron.backfill', async () => {
    let whales: Whale[];

    if (single) {
      const whale = await getWhale(single);
      if (!whale) return { processed: 0, created: 0, note: `unknown whale ${single}` };
      whales = [whale];
    } else {
      // Few whales per run by design: this is the most API-expensive job in the
      // system, and Birdeye's free tier is about one request a second.
      whales = await getWhalesToBackfill(limit);
    }

    if (!whales.length) {
      return { processed: 0, created: 0, note: 'every tracked whale is fully backfilled' };
    }

    const { results, errors } = await backfillWhales(whales, { maxTransactions });

    return {
      processed: results.length,
      created: results.reduce((sum, r) => sum + r.stored, 0),
      transactionsScanned: results.reduce((sum, r) => sum + r.scanned, 0),
      swapsParsed: results.reduce((sum, r) => sum + r.parsed, 0),
      // Trades we found but could not price historically. Reported rather than
      // stored at a guess, because a fabricated cost basis is worse than none.
      unpriceable: results.reduce((sum, r) => sum + r.unpriceable, 0),
      positionsRebuilt: results.reduce((sum, r) => sum + r.positions, 0),
      completed: results.filter((r) => r.reachedEnd).map((r) => r.address),
      errors: errors.slice(0, 10),
    };
  });
}

export const POST = GET;

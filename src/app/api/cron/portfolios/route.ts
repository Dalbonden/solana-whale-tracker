import { authorizeJob, runJob } from '@/lib/api';
import { pruneInactiveWhales } from '@/lib/core/discovery';
import { snapshotWhales } from '@/lib/core/portfolio';
import { listWhales } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/portfolios — portfolio snapshots and rescoring.
 *
 * Values every tracked whale's holdings, writes a snapshot row per position,
 * recomputes the whale score from the fresh numbers, and untracks wallets that
 * have gone dormant or fallen below the portfolio floor.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 200);
  const prune = url.searchParams.get('prune') !== 'false';

  return runJob('cron.portfolios', async () => {
    // Highest-scoring whales first: if the run is truncated by the function
    // timeout, the wallets people actually look at stay fresh.
    const { rows: whales } = await listWhales({ pageSize: limit, sort: 'score' });
    if (!whales.length) {
      return { processed: 0, created: 0, note: 'no whales tracked yet' };
    }

    const { results, errors } = await snapshotWhales(whales);
    const pruned = prune ? await pruneInactiveWhales(whales) : { untracked: [] };

    const totalUsd = results.reduce((sum, result) => sum + result.totalUsd, 0);
    const memeUsd = results.reduce((sum, result) => sum + result.memeUsd, 0);

    return {
      processed: results.length,
      created: results.reduce((sum, result) => sum + result.holdings, 0),
      aggregateValueUsd: Number(totalUsd.toFixed(2)),
      aggregateMemeUsd: Number(memeUsd.toFixed(2)),
      untracked: pruned.untracked,
      errors: errors.slice(0, 10),
    };
  });
}

export const POST = GET;

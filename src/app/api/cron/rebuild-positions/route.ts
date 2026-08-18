import { authorizeJob, runJob } from '@/lib/api';
import { rebuildPositions } from '@/lib/core/rebuild-positions';
import { getKnownWhaleAddresses } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/rebuild-positions — rebuilds the position ledger from trades.
 *
 * Run once after applying the whale_positions migration to backfill history,
 * and any time the ledger is suspected of drifting from the trade table. Safe
 * to re-run: each whale's positions are recomputed from scratch, so the result
 * depends only on the trades, never on what was there before.
 *
 * `?address=` rebuilds a single wallet, which is the fast path when debugging
 * one profile.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const single = url.searchParams.get('address');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);

  return runJob('cron.rebuild-positions', async () => {
    let addresses: string[];

    if (single) {
      addresses = [single];
    } else {
      // Untracked whales are included: their profile pages still render, and a
      // ledger that silently skipped them would show an empty positions tab.
      addresses = [...(await getKnownWhaleAddresses())].slice(0, limit);
    }

    if (!addresses.length) {
      return { processed: 0, created: 0, note: 'no whales to rebuild' };
    }

    const { results, errors } = await rebuildPositions(addresses);

    return {
      processed: results.length,
      created: results.reduce((sum, r) => sum + r.positions, 0),
      tradesReplayed: results.reduce((sum, r) => sum + r.trades, 0),
      openPositions: results.reduce((sum, r) => sum + r.open, 0),
      incompleteBasis: results.reduce((sum, r) => sum + r.incompleteBasis, 0),
      errors: errors.slice(0, 10),
    };
  });
}

export const POST = GET;

import { authorizeJob, runJob } from '@/lib/api';
import { config } from '@/lib/config';
import { syncWhales } from '@/lib/core/whale-tracker';
import { getWhalesToSync } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/sync — polling backstop for whale activity.
 *
 * The Helius webhook is the real-time path; this job exists so the tracker
 * stays correct when the webhook is not configured, is briefly down, or drops a
 * delivery. Whales are picked oldest-cursor-first, so every wallet is reached
 * in turn regardless of how many are tracked.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit')) || config.limits.whalesPerSync;

  return runJob('cron.sync', async () => {
    const whales = await getWhalesToSync(limit);
    if (!whales.length) {
      return { processed: 0, created: 0, note: 'no whales tracked yet — run /api/cron/discover' };
    }

    const result = await syncWhales(whales);

    return {
      processed: result.synced,
      created: result.totals.stored,
      failed: result.failed,
      parsedSwaps: result.totals.parsed,
      alertsCreated: result.totals.alerts,
      errors: result.errors.slice(0, 10),
    };
  });
}

export const POST = GET;

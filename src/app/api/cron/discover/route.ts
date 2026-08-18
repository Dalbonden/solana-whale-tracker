import { authorizeJob, runJob } from '@/lib/api';
import { runDiscovery } from '@/lib/core/discovery';
import { ensureCoreTokens } from '@/lib/core/meme-filter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/discover — whale discovery pass.
 *
 * Scans the top traders and largest holders of the tracked meme universe,
 * scores each candidate, and persists the ones that qualify. The most expensive
 * job in the system, so it runs least often.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const maxCandidates = Number(url.searchParams.get('max')) || undefined;
  /*
   * `?includeKnown=true` re-evaluates wallets already tracked instead of
   * skipping them. Use it to refresh provider-sourced activity figures for the
   * existing roster — our own trade history only covers the period since
   * tracking began, so it under-reports a whale's real 30-day activity until
   * the wallet has been watched for a while.
   */
  const includeKnown = url.searchParams.get('includeKnown') === 'true';

  return runJob('cron.discover', async () => {
    // Cheap and idempotent; guarantees the core universe exists even if the
    // seed SQL was never run.
    await ensureCoreTokens();

    const result = await runDiscovery({ maxCandidates, includeKnown });

    return {
      processed: result.evaluated,
      created: result.qualified,
      candidates: result.candidates,
      added: result.added,
      // Rejections are the useful debugging output when nothing qualifies.
      rejectedSample: result.rejected.slice(0, 10),
      errors: result.errors.slice(0, 10),
    };
  });
}

export const POST = GET;

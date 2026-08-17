import { authorizeJob, runJob } from '@/lib/api';
import {
  discoverNewMemeTokens,
  ensureCoreTokens,
  refreshTokenMarketData,
} from '@/lib/core/meme-filter';
import { listActiveMints } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/tokens — keeps the meme-token universe current.
 *
 * Refreshes cached market data for tracked tokens and admits new pump.fun
 * graduates / trending tokens that pass the meme classifier.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const discover = url.searchParams.get('discover') !== 'false';

  return runJob('cron.tokens', async () => {
    await ensureCoreTokens();

    const discovery = discover
      ? await discoverNewMemeTokens(30)
      : { evaluated: 0, added: [] as string[] };

    const mints = await listActiveMints();
    const refreshed = await refreshTokenMarketData(mints);

    return {
      processed: refreshed,
      created: discovery.added.length,
      trackedTokens: mints.length,
      evaluatedCandidates: discovery.evaluated,
      addedTokens: discovery.added,
    };
  });
}

export const POST = GET;

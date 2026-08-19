import { authorizeJob, runJob } from '@/lib/api';
import { extendTrace, listUnconfirmedTraces, newCounter } from '@/lib/core/trace-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/deepen-traces — walks cached wallet histories further back.
 *
 * A forensics request can only afford a few pages per wallet, which is rarely
 * enough to reach an active wallet's first transaction. This job spends the
 * time a page load cannot: it picks the wallets whose origin is still unknown,
 * least recently touched first, and walks each one deeper.
 *
 * That is what turns a per-request cap into a cumulative one. A wallet seen at
 * several launches, or left alone with this cron running, eventually reaches
 * genesis — and once it does, its funding origin is settled permanently and it
 * is never walked again.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 100);
  const pages = Math.min(Number(url.searchParams.get('pages')) || 5, 20);

  return runJob('cron.deepen-traces', async () => {
    const pending = await listUnconfirmedTraces(limit);
    if (!pending.length) {
      return { processed: 0, created: 0, note: 'every cached wallet has been traced to its origin' };
    }

    const counter = newCounter();
    let confirmed = 0;
    let failed = 0;
    const errors: Array<{ address: string; error: string }> = [];

    // Serial: the point is depth over time, not speed, and Helius rate-limits
    // parallel history walks on the free tier.
    for (const trace of pending) {
      try {
        const walked = await extendTrace(trace, trace.pagesWalked + pages, counter);
        if (walked.originConfirmed) confirmed += 1;
        if (walked.lastWalkFailed) failed += 1;
      } catch (error) {
        errors.push({ address: trace.address, error: (error as Error).message });
      }
    }

    return {
      processed: pending.length,
      created: confirmed,
      originsConfirmed: confirmed,
      walksRateLimited: failed,
      requests: counter.requests,
      cacheAvailable: counter.cacheAvailable,
      errors: errors.slice(0, 10),
    };
  });
}

export const POST = GET;

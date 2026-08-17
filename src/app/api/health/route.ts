import { handleError, ok } from '@/lib/api';
import { config, integrationStatus } from '@/lib/config';
import { dbHealthy } from '@/lib/db/client';
import { getRecentJobRuns } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/health
 *
 * Reports which integrations are configured and reachable. The dashboard shows
 * this so a deployment that is missing a key looks broken rather than looking
 * like a market with no whale activity.
 */
export async function GET() {
  try {
    const configured = integrationStatus();

    const [database, birdeye] = await Promise.all([
      dbHealthy(),
      (async () => {
        if (!config.birdeye.enabled) return { ok: false, error: 'not configured' };
        try {
          const { ping } = await import('@/lib/providers/birdeye');
          await ping();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      })(),
    ]);

    const jobs = database.ok ? await getRecentJobRuns(10).catch(() => []) : [];

    const degraded = !database.ok || !configured.helius || !configured.birdeye;

    return ok(
      {
        status: degraded ? 'degraded' : 'ok',
        configured,
        checks: { database, birdeye },
        rpc: config.solana.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***'),
        recentJobs: jobs,
        timestamp: new Date().toISOString(),
      },
      { status: degraded ? 207 : 200 }
    );
  } catch (error) {
    return handleError(error, 'health');
  }
}

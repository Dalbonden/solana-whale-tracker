import { handleError, ok } from '@/lib/api';
import { config, integrationStatus } from '@/lib/config';
import { dbHealthy } from '@/lib/db/client';
import { schedulerStatus } from '@/lib/core/scheduler';
import { getRecentJobRuns } from '@/lib/db/repositories';

/**
 * Reduces a provider endpoint to just its host.
 *
 * This is served publicly, and providers put credentials in wildly different
 * places: Helius uses `?api-key=`, Alchemy puts the key in the path as
 * `/v2/<key>`. A regex that redacted only the query string therefore published
 * the Alchemy key in full the moment standard RPC was pointed at it.
 *
 * So rather than pattern-matching the secret, this keeps only what the reader
 * actually needs — which provider is serving each role — and throws the rest
 * away. Anything after the host is `/***` regardless of what it contains.
 */
function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    const hasDetail = (parsed.pathname && parsed.pathname !== '/') || parsed.search;
    return `${parsed.protocol}//${parsed.host}${hasDetail ? '/***' : ''}`;
  } catch {
    return '(unset or malformed)';
  }
}

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

    // pump.fun is unofficial and often down; snipe detection depends on dating
    // a token's launch, so report whether that source is answering.
    const { isReachable } = await import('@/lib/providers/pumpfun');
    const pumpfunUp = await isReachable().catch(() => false);

    const jobs = database.ok ? await getRecentJobRuns(10).catch(() => []) : [];

    // Paid-plan endpoints this key has been observed to lack. Populated lazily
    // as calls 401, so it is only meaningful after some traffic has run.
    const { restrictedEndpoints } = await import('@/lib/providers/birdeye');
    const restricted = restrictedEndpoints();

    /*
     * Providers whose allowance is spent. Reported explicitly because the
     * symptom is otherwise indistinguishable from a network fault: every call
     * fails, jobs log errors, and nothing says the reason is a monthly quota
     * that will reset on its own.
     */
    const { budgetStatus } = await import('@/lib/providers/budget');
    const exhausted = budgetStatus();

    const degraded =
      !database.ok || !configured.helius || !configured.birdeye || exhausted.length > 0;

    return ok(
      {
        status: degraded ? 'degraded' : 'ok',
        configured,
        checks: {
          database,
          birdeye,
          pumpfun: {
            ok: pumpfunUp,
            note: pumpfunUp
              ? undefined
              : 'pump.fun API unreachable — snipe detection falls back to first-trade time from Birdeye OHLCV.',
          },
        },
        exhaustedProviders: exhausted.length
          ? {
              providers: exhausted,
              note:
                'These providers reported their usage allowance is spent, so the app is ' +
                'skipping their calls until the retry time rather than burning what is left. ' +
                'Allowances reset on the provider’s own billing cycle.',
            }
          : undefined,
        birdeyePlan: {
          restrictedEndpoints: restricted,
          note: restricted.length
            ? 'Free-tier key: these endpoints are unavailable and the app is using its fallbacks. ' +
              'multi_price falls back to one call per mint, which is slower but correct; ' +
              'wallet_token_list falls back to RPC balances plus a price lookup.'
            : undefined,
        },
        rpc: {
          standard: redactEndpoint(config.solana.rpcUrl),
          das: redactEndpoint(config.solana.dasUrl),
          splitFromHelius: config.solana.rpcIsSeparateFromHelius,
          note: config.solana.rpcIsSeparateFromHelius
            ? undefined
            : 'Standard RPC and DAS are both on the Helius account. Set SOLANA_RPC_URL to a second provider to move the bulk load off it; DAS stays on Helius automatically.',
        },
        scheduler: schedulerStatus(),
      recentJobs: jobs,
        timestamp: new Date().toISOString(),
      },
      { status: degraded ? 207 : 200 }
    );
  } catch (error) {
    return handleError(error, 'health');
  }
}

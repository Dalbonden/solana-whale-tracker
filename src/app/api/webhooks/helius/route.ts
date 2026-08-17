import { fail, ok, timingSafeEqual } from '@/lib/api';
import { config } from '@/lib/config';
import { ingestTransactions } from '@/lib/core/whale-tracker';
import { getTrackedAddresses, recordJobRun } from '@/lib/db/repositories';
import type { HeliusEnhancedTransaction } from '@/lib/providers/helius';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Helius batches transactions; parsing + pricing a large batch needs headroom. */
export const maxDuration = 60;

/**
 * POST /api/webhooks/helius — real-time ingest.
 *
 * Helius pushes enhanced transactions here the moment they confirm for any
 * subscribed whale address. This is the path that makes alerts real-time; the
 * sync cron exists only as a safety net for anything the webhook misses.
 *
 * Auth: the `authHeader` value registered with the webhook must match
 * HELIUS_WEBHOOK_SECRET. Requests without it are rejected — this endpoint is
 * publicly reachable and writes to the database.
 *
 * The handler always returns 2xx once authenticated, even when processing
 * fails. Helius retries on non-2xx, and a poison payload that fails
 * deterministically would otherwise be redelivered indefinitely; failures are
 * recorded in `job_runs` instead.
 */
export async function POST(request: Request) {
  const started = Date.now();

  const secret = config.auth.webhookSecret;
  if (!secret) {
    return fail('HELIUS_WEBHOOK_SECRET is not set; the webhook endpoint is disabled.', 503);
  }

  const provided =
    request.headers.get('authorization') ?? request.headers.get('x-webhook-secret') ?? '';
  const normalised = provided.startsWith('Bearer ') ? provided.slice(7) : provided;

  if (!timingSafeEqual(normalised, secret)) {
    return fail('Unauthorized', 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail('Invalid JSON body', 400);
  }

  const transactions = (Array.isArray(payload) ? payload : [payload]) as HeliusEnhancedTransaction[];
  const valid = transactions.filter(
    (tx) => tx && typeof tx.signature === 'string' && Array.isArray(tx.accountData)
  );

  if (!valid.length) {
    return ok({ received: transactions.length, parsed: 0, stored: 0, alerts: 0 });
  }

  try {
    const tracked = new Set(await getTrackedAddresses());
    const result = await ingestTransactions(valid, tracked);

    await recordJobRun({
      job: 'webhook.helius',
      status: 'ok',
      durationMs: Date.now() - started,
      processed: valid.length,
      created: result.stored,
      detail: { parsed: result.parsed, alerts: result.alerts },
    });

    return ok({
      received: transactions.length,
      parsed: result.parsed,
      stored: result.stored,
      alerts: result.alerts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[webhook:helius]', message);

    await recordJobRun({
      job: 'webhook.helius',
      status: 'error',
      durationMs: Date.now() - started,
      processed: valid.length,
      detail: { error: message },
    }).catch(() => undefined);

    // Acknowledge so Helius does not retry a payload that will fail again.
    return ok({ received: transactions.length, error: message, retried: false }, { status: 202 });
  }
}

/** GET — lightweight reachability check for the Helius dashboard. */
export async function GET() {
  return ok({
    endpoint: 'helius-webhook',
    configured: Boolean(config.auth.webhookSecret),
    expects: 'POST with Authorization header matching HELIUS_WEBHOOK_SECRET',
  });
}

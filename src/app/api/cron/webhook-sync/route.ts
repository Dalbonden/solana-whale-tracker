import { authorizeJob, fail, runJob } from '@/lib/api';
import { config } from '@/lib/config';
import { getTrackedAddresses } from '@/lib/db/repositories';
import { upsertWebhook } from '@/lib/providers/helius';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/webhook-sync — keeps the Helius webhook subscription in step
 * with the tracked whale list.
 *
 * Discovery adds wallets continuously, and a webhook only pushes transactions
 * for addresses it is subscribed to, so without this job newly-discovered
 * whales would only ever be picked up by the slower polling cron.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) return auth.response;

  if (!config.solana.hasHelius) {
    return fail('HELIUS_API_KEY is not set; webhook sync is unavailable.', 503);
  }
  if (!config.auth.webhookSecret) {
    return fail('HELIUS_WEBHOOK_SECRET is not set; refusing to register an unauthenticated webhook.', 503);
  }

  return runJob('cron.webhook-sync', async () => {
    const addresses = await getTrackedAddresses();
    if (!addresses.length) {
      return { processed: 0, created: 0, note: 'no tracked whales to subscribe' };
    }

    const webhook = await upsertWebhook(addresses);

    return {
      processed: addresses.length,
      created: 0,
      webhookID: webhook.webhookID,
      webhookURL: webhook.webhookURL,
      subscribedAddresses: webhook.accountAddresses?.length ?? addresses.length,
    };
  });
}

export const POST = GET;

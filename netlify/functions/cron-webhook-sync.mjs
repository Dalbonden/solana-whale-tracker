import { runJob } from '../lib/run-job.mjs';

// Keeps the Helius subscription matching the tracked roster. Cheap, and it repairs the SWAP-only subscription.
export default async () => runJob('/api/cron/webhook-sync');

export const config = { schedule: '50 */6 * * *' };

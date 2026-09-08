import { runJob } from '../lib/run-job.mjs';

// Polling backstop. sync-cadence decides which wallets are actually due, so most runs do no provider work at all.
export default async () => runJob('/api/cron/sync?limit=5');

export const config = { schedule: '*/15 * * * *' };

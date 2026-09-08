import { runJob } from '../lib/run-job.mjs';

// Nightly position replay, a few wallets at a time.
export default async () => runJob('/api/cron/rebuild-positions?limit=4');

export const config = { schedule: '15 3 * * *' };

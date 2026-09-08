import { runJob } from '../lib/run-job.mjs';

// Token metadata refresh.
export default async () => runJob('/api/cron/tokens');

export const config = { schedule: '40 */4 * * *' };

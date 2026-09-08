import { runJob } from '../lib/run-job.mjs';

// One wallet per run, walking backwards from its own stored cursor.
export default async () => runJob('/api/cron/backfill?limit=1&max=100');

export const config = { schedule: '10 */6 * * *' };

import { runJob } from '../lib/run-job.mjs';

// Trace walks are cached and resumable, so a small batch is progress, not a partial answer.
export default async () => runJob('/api/cron/deepen-traces?limit=3&pages=3');

export const config = { schedule: '20 * * * *' };

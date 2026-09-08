import { runJob } from '../lib/run-job.mjs';

// Candidate discovery. Twice a day is plenty and it is the most provider-hungry job.
export default async () => runJob('/api/cron/discover');

export const config = { schedule: '30 5,17 * * *' };

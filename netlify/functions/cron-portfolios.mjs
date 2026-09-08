import { runJob } from '../lib/run-job.mjs';

// Two wallets a run: this is the job that took 56s on Render and would be killed here.
export default async () => runJob('/api/cron/portfolios?limit=2');

export const config = { schedule: '0,30 * * * *' };

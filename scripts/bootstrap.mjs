#!/usr/bin/env node
/**
 * First-run bootstrap: kicks the jobs in the right order against a running
 * deployment, so a fresh install has data without waiting for the cron schedule.
 *
 * Usage:
 *   CRON_SECRET=... node scripts/bootstrap.mjs [base-url]
 *
 * Defaults to http://localhost:3000.
 */

const base = (process.argv[2] ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  ''
);
const secret = process.env.CRON_SECRET;

if (!secret) {
  console.error('CRON_SECRET is not set. Job endpoints refuse unauthenticated calls.');
  process.exit(1);
}

/** Order matters: tokens define the universe discovery searches within. */
const STEPS = [
  ['tokens', '/api/cron/tokens', 'Seed and refresh the meme-token universe'],
  ['discover', '/api/cron/discover', 'Find and score whale wallets'],
  ['sync', '/api/cron/sync?limit=25', 'Ingest recent whale trades'],
  ['portfolios', '/api/cron/portfolios?limit=25', 'Snapshot portfolios and rescore'],
  ['webhook', '/api/cron/webhook-sync', 'Register the Helius real-time webhook'],
];

console.log(`Bootstrapping ${base}\n`);

for (const [name, path, description] of STEPS) {
  process.stdout.write(`→ ${name.padEnd(11)} ${description}… `);
  const started = Date.now();

  try {
    const response = await fetch(base + path, {
      headers: { authorization: `Bearer ${secret}` },
    });
    const payload = await response.json().catch(() => ({}));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (!response.ok) {
      console.log(`failed (${response.status}) in ${seconds}s`);
      console.log(`  ${payload.error ?? payload.detail ?? 'unknown error'}`);
      // Later steps depend on earlier ones, so a failure here is worth
      // surfacing but not necessarily fatal — keep going.
      continue;
    }

    console.log(`ok in ${seconds}s`);
    const summary = Object.entries(payload)
      .filter(([key]) => ['processed', 'created', 'candidates', 'trackedTokens', 'failed'].includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    if (summary) console.log(`  ${summary}`);
  } catch (error) {
    console.log('failed');
    console.log(`  ${error.message}`);
  }
}

console.log(`\nDone. Open ${base} to view the dashboard.`);

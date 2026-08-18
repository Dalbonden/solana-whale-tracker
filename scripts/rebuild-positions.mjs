#!/usr/bin/env node
/**
 * Rebuilds the position ledger by calling /api/cron/rebuild-positions.
 *
 * A thin wrapper on purpose. The replay logic lives in TypeScript beside the
 * ingest path so both run the same `applyTrade` — duplicating it here in plain
 * JS would guarantee the two drift apart, and a ledger that disagrees with the
 * live path is worse than no ledger.
 *
 * Usage:
 *   npm run positions:rebuild
 *   APP_URL=https://your-app.onrender.com npm run positions:rebuild
 *   npm run positions:rebuild -- --address=9xQe...
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// .env.local is not loaded by plain node, and CRON_SECRET usually lives there.
async function loadEnvFile() {
  for (const name of ['.env.local', '.env']) {
    try {
      const text = await readFile(join(root, name), 'utf8');
      for (const line of text.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key]) continue;
        process.env[key] = rawValue.replace(/^["']|["']$/g, '');
      }
      return name;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

await loadEnvFile();

const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const secret = process.env.CRON_SECRET;

if (!secret) {
  console.error('CRON_SECRET is not set. Add it to .env.local or export it.');
  process.exit(1);
}

const addressArg = process.argv.find((arg) => arg.startsWith('--address='));
const query = addressArg ? `?address=${encodeURIComponent(addressArg.split('=')[1])}` : '';
const url = `${base}/api/cron/rebuild-positions${query}`;

console.log(`Rebuilding positions via ${url}`);

const started = Date.now();
let response;
try {
  response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
} catch (error) {
  console.error(`\nCould not reach ${base}: ${error.message}`);
  console.error('Is the server running? Try `npm run dev` first, or set APP_URL.');
  process.exit(1);
}

const body = await response.text();
let payload;
try {
  payload = JSON.parse(body);
} catch {
  console.error(`\nHTTP ${response.status} — non-JSON response:\n${body.slice(0, 500)}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`\nHTTP ${response.status}:`, payload);
  process.exit(1);
}

const result = payload.result ?? payload;
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  whales rebuilt   ${result.processed ?? 0}`);
console.log(`  trades replayed  ${result.tradesReplayed ?? 0}`);
console.log(`  positions written ${result.created ?? 0}`);
console.log(`  still open       ${result.openPositions ?? 0}`);
console.log(`  unknown basis    ${result.incompleteBasis ?? 0}`);

if (result.errors?.length) {
  console.log('\nErrors:');
  for (const error of result.errors) console.log(`  ${error.address}: ${error.error}`);
}

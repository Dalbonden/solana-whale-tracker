#!/usr/bin/env node
/**
 * Applies supabase/schema.sql and supabase/seed.sql to the configured project.
 *
 * Supabase's JS client cannot execute arbitrary DDL, so this uses the Postgres
 * connection string directly. Set SUPABASE_DB_URL to the "Connection string →
 * URI" value from Supabase → Project Settings → Database.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/apply-schema.mjs
 *
 * If you would rather not install `pg`, paste both files into the Supabase SQL
 * editor instead — that is the documented path in README.md.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error(
    'SUPABASE_DB_URL is not set.\n\n' +
      'Get it from Supabase → Project Settings → Database → Connection string (URI),\n' +
      'or paste supabase/schema.sql and supabase/seed.sql into the SQL editor by hand.'
  );
  process.exit(1);
}

let pg;
try {
  pg = await import('pg');
} catch {
  console.error(
    'This script needs the `pg` package:\n  npm install --no-save pg\n\n' +
      'Or apply supabase/schema.sql and supabase/seed.sql through the Supabase SQL editor.'
  );
  process.exit(1);
}

const client = new pg.default.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  for (const file of ['supabase/schema.sql', 'supabase/seed.sql']) {
    const sql = await readFile(join(root, file), 'utf8');
    process.stdout.write(`Applying ${file}… `);
    await client.query(sql);
    console.log('ok');
  }

  const { rows } = await client.query(
    'select count(*)::int as tokens from public.meme_tokens where is_active'
  );
  console.log(`\nSchema applied. ${rows[0].tokens} meme tokens in the universe.`);
} catch (error) {
  console.error('\nFailed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

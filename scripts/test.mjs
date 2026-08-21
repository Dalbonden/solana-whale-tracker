#!/usr/bin/env node
/**
 * Runs the swap-parser test suite.
 *
 * `parse.ts` is pure and its only value imports are relative, so it compiles
 * standalone — no test framework, bundler or extra dependency required. The
 * cross-module `@/` imports it uses are type-only and erase at compile time,
 * which is why tsc reports them as unresolved but still emits usable JS.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.test-build');

rmSync(outDir, { recursive: true, force: true });

// Invoke the local tsc through node rather than npx: on Windows `npx.cmd`
// cannot be spawned without a shell, which would silently skip compilation.
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const compile = spawnSync(
  process.execPath,
  [
    tsc,
    'src/lib/solana/parse.ts',
    'src/lib/solana/constants.ts',
    'src/lib/core/positions.ts',
    'src/lib/core/archetypes.ts',
    'src/lib/core/wealth.ts',
    'src/lib/db/paginate.ts',
    '--rootDir',
    'src/lib',
    '--outDir',
    '.test-build',
    '--module',
    'commonjs',
    '--target',
    'ES2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: root, encoding: 'utf8' }
);

if (compile.error) {
  console.error('Could not run tsc:', compile.error.message);
  process.exit(1);
}

// Only type-resolution errors for the erased `@/` type imports are expected.
const fatal = `${compile.stdout ?? ''}${compile.stderr ?? ''}`
  .split('\n')
  .filter((line) => line.includes('error TS') && !line.includes('TS2307'));

if (fatal.length) {
  console.error('Compilation failed:\n' + fatal.join('\n'));
  process.exit(1);
}

if (!existsSync(join(outDir, 'solana', 'parse.js'))) {
  console.error('Compilation produced no output; cannot run tests.');
  process.exit(1);
}

const run = spawnSync(process.execPath, ['--test', 'tests/*.test.js'], {
  cwd: root,
  stdio: 'inherit',
});

rmSync(outDir, { recursive: true, force: true });
process.exit(run.status ?? 1);

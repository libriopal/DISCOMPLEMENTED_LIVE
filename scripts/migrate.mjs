#!/usr/bin/env node
/**
 * Migration runner.
 *
 * `db:migrate` used to be this shell loop:
 *
 *   for f in migrations/*.sql; do wrangler d1 execute bicameral --file="$f" --remote; done
 *
 * which tracked nothing, ordered by shell glob, and — the part that matters —
 * did not stop. `for` ignores the exit status of the body, and the loop's own
 * status is that of the last command, so a migration that failed in the middle
 * was invisible twice over: the run kept going through every later file, and it
 * exited 0.
 *
 * Measured, not assumed. Two probe migrations were added to a fresh local D1 —
 * `025_deliberately_broken.sql` (invalid SQL) and `026_after_broken.sql`
 * (creates `probe_after_broken`) — and each runner was pointed at them:
 *
 *   old shell loop:  exit 0, and `probe_after_broken` exists afterwards
 *   this runner:     exit 1, stops at 025, `probe_after_broken` never created
 *
 * The replacement is `wrangler d1 migrations apply`, which is not a new
 * mechanism: `migrations_dir` is already declared in wrangler.toml, the
 * `d1_migrations` ledger table already exists on the production database, and
 * the integration suite already applies migrations through wrangler's own
 * `readD1Migrations`. The shell loop was the odd one out, and the split was
 * live — the production ledger records exactly one migration (`001_init.sql`,
 * applied 2026-08-20) because every run since went through the loop, which
 * writes nothing.
 *
 * So this script is deliberately thin. It adds the three things wrangler will
 * not do for us:
 *
 *   1. Lints filenames first. Wrangler orders by parsed number, so two files
 *      claiming one number is a split brain between what ran here and what ran
 *      there. lint-migrations.mjs is the check; running it after the fact is
 *      too late.
 *   2. Defaults to `--local`. The old loop was hardcoded `--remote`, so the
 *      obvious command was the dangerous one. Remote now has to be asked for.
 *   3. Propagates the exit code, and says which migrations are pending before
 *      applying them.
 *
 * Usage:
 *   pnpm db:migrate                 # local D1
 *   pnpm db:migrate --remote        # production D1, after showing what's pending
 *   pnpm db:migrate --list          # show pending, apply nothing
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'apps', 'web');
const DATABASE = 'bicameral';

const argv = process.argv.slice(2);
const remote = argv.includes('--remote');
const listOnly = argv.includes('--list');

/**
 * Wrangler is invoked from apps/web because that is where the wrangler.toml
 * declaring the D1 binding lives; `migrations_dir` there resolves through the
 * apps/web/migrations symlink to the one real directory at the repo root.
 */
function wrangler(args, { capture = false } = {}) {
  return spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', ...args, DATABASE, remote ? '--remote' : '--local'],
    {
      cwd: WEB,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
      // A stale or invalid CLOUDFLARE_API_TOKEN in the environment beats the
      // working OAuth login and fails with "Authentication error [code: 10000]",
      // which reads like a permissions problem rather than a token problem.
      // Unset it here so the login wrangler already has is what gets used.
      //
      // On CI there is no OAuth login — the token is the only credential there
      // is — so unsetting it would turn every CI migration into an auth
      // failure. `CI` is set by GitHub Actions (and by every other runner);
      // keep the token when it is present.
      env: process.env.CI
        ? process.env
        : { ...process.env, CLOUDFLARE_API_TOKEN: undefined },
    }
  );
}

// 1. Filenames before anything touches a database.
const lint = spawnSync('node', [resolve(ROOT, 'scripts', 'lint-migrations.mjs')], {
  stdio: 'inherit',
});
if (lint.status !== 0) process.exit(lint.status ?? 1);

// 2. Say what is about to happen. Against production this is the last point
//    where a surprise is cheap.
console.log(`\nPending on the ${remote ? 'REMOTE (production)' : 'local'} database:\n`);
const list = wrangler(['migrations', 'list']);
if (list.status !== 0) process.exit(list.status ?? 1);

if (listOnly) process.exit(0);

// 3. Apply, and let wrangler's exit code be ours. It stops at the first
//    failure, so a non-zero status here means later migrations did not run.
const apply = wrangler(['migrations', 'apply']);
if (apply.status !== 0) {
  console.error(
    '\nmigrate failed — stopped at the first failing migration; nothing after it ran.'
  );
  process.exit(apply.status ?? 1);
}

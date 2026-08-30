#!/usr/bin/env node
/**
 * Migration filename linter.
 *
 * Two migrations once shared the number 015 (`preference_matrix` and
 * `user_events`). Nothing caught it because `db:migrate` is a shell loop over
 * `migrations/*.sql`, which orders lexicographically and so happened to stay
 * deterministic. That masked the defect rather than preventing it: the
 * `migrations_dir` declared in wrangler.toml means `wrangler d1 migrations
 * apply` is one keystroke away, and it orders by parsed number — at which
 * point two files claiming one version is a split brain between what ran
 * locally and what ran remotely.
 *
 * Run in CI so the collision cannot come back.
 */

import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const NAME = /^(\d{3,})_[a-z0-9_]+\.sql$/;

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
const errors = [];
const byNumber = new Map();

for (const file of files.sort()) {
  const match = NAME.exec(file);
  if (match === null) {
    errors.push(`${file}: expected NNN_snake_case_name.sql`);
    continue;
  }
  const number = match[1];
  const existing = byNumber.get(number);
  if (existing !== undefined) {
    errors.push(`duplicate migration number ${number}: ${existing} and ${file}`);
    continue;
  }
  byNumber.set(number, file);
}

// A gap is legal but usually means a migration was deleted rather than
// superseded, so surface it as a warning without failing the build.
const numbers = [...byNumber.keys()].map(Number).sort((a, b) => a - b);
const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1);
for (const n of gaps) console.warn(`  warning: gap in sequence before ${String(n).padStart(3, '0')}`);

if (errors.length > 0) {
  console.error('migration lint failed:');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(`migration lint passed: ${byNumber.size} migrations, no duplicate numbers`);

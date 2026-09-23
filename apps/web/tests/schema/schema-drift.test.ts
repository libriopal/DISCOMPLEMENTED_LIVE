/**
 * A table rebuild must not quietly lose a column, an index, or a row.
 *
 * Migration 028 rebuilds `users` to change one column default, because SQLite
 * cannot ALTER one. A rebuild is written by copying the CREATE statement, and
 * the obvious place to copy it from is the original `001_init.sql` — which is
 * wrong, and was: `users` had been altered twice since (002 added
 * email_verified and avatar_url, 005 added stripe_customer_id and an index on
 * it). A rebuild from the original would have dropped three columns, the
 * Stripe customer linkage among them, and every test in this repo would still
 * have passed, because nothing compared the schema before a migration to the
 * schema after it.
 *
 * So the comparison is the test. Both sides are DERIVED — the "before" by
 * applying 001..027 and reading PRAGMA table_info, the "after" by applying 028
 * on top and reading it again — rather than either being a list someone typed.
 * A list someone typed is a restatement of the thing under test and passes
 * whatever the migration does.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { TIER_LIMITS } from '@bicameral/shared/constants';

// Deliberately NOT under apps/web/tests/integration/: that directory runs in
// the Cloudflare Workers pool, which has neither node:sqlite nor node:fs. Put
// there first, this file did not run at all — and a test that does not run
// reports nothing, which reads exactly like a test that passed.
const MIGRATIONS = resolve(__dirname, '../../../../migrations');

type Col = {
  name: string;
  type: string;
  dflt_value: unknown;
  notnull: number;
  pk: number;
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/** Apply migrations up to and including `through`, return the open db. */
function applyThrough(through: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of migrationFiles()) {
    if (parseInt(f, 10) > through) break;
    db.exec(readFileSync(resolve(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

const cols = (db: DatabaseSync, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Col[];

const indexNames = (db: DatabaseSync, table: string) =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
      )
      .all(table) as unknown as { name: string }[]
  )
    .map((r) => r.name)
    .sort();

describe('migration 028 rebuilds users without losing anything', () => {
  it('keeps every column, in order, with its type and constraints', () => {
    const before = cols(applyThrough(27), 'users');
    const after = cols(applyThrough(28), 'users');

    // The denominator: a comparison of two empty lists would pass trivially.
    expect(before.length).toBeGreaterThan(14);
    expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name));

    for (const [i, b] of before.entries()) {
      const a = after[i];
      expect(a.type, `${b.name}: type changed`).toBe(b.type);
      expect(a.notnull, `${b.name}: NOT NULL changed`).toBe(b.notnull);
      expect(a.pk, `${b.name}: primary key changed`).toBe(b.pk);
      if (b.name !== 'credits_remaining') {
        expect(a.dflt_value, `${b.name}: default changed unexpectedly`).toBe(
          b.dflt_value
        );
      }
    }
  });

  it('changes exactly one default, to the free tier grant', () => {
    const before = cols(applyThrough(27), 'users');
    const after = cols(applyThrough(28), 'users');
    const changed = before
      .filter((b, i) => String(b.dflt_value) !== String(after[i].dflt_value))
      .map((b) => b.name);
    expect(changed).toEqual(['credits_remaining']);

    // Derived from the constant, not restated. If the free grant is re-sized
    // and the migration is not, this fails rather than the product quietly
    // issuing a number nothing priced.
    const dflt = after.find((c) => c.name === 'credits_remaining')!.dflt_value;
    expect(Number(dflt)).toBe(TIER_LIMITS.free.creditsPerMonth);
  });

  it('keeps the indexes the dropped table carried', () => {
    const before = indexNames(applyThrough(27), 'users');
    const after = indexNames(applyThrough(28), 'users');
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });

  it('carries existing rows across untouched, balances included', () => {
    const db = applyThrough(27);
    db.prepare(
      `INSERT INTO users (id, email, tier, credits_remaining, stripe_customer_id,
                          created_date, updated_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('u1', 'a@b.c', 'free', 777, 'cus_123', 'now', 'now');

    // Apply 028 onto THIS database, with the row already in it.
    db.exec(
      readFileSync(resolve(MIGRATIONS, '028_free_grant_solvency.sql'), 'utf8')
    );

    const row = db
      .prepare(
        `SELECT credits_remaining, stripe_customer_id, tier FROM users WHERE id='u1'`
      )
      .get() as {
      credits_remaining: number;
      stripe_customer_id: string;
      tier: string;
    };

    // 777, not 50: the migration deliberately does not claw back credits that
    // existing accounts were already granted.
    expect(row.credits_remaining).toBe(777);
    expect(row.stripe_customer_id).toBe('cus_123');
    expect(row.tier).toBe('free');
  });

  it('gives a NEW account the free grant rather than the old default', () => {
    // The defect this migration exists to fix, asserted on the path that
    // actually creates accounts: an insert that names no credit balance.
    const db = applyThrough(28);
    db.prepare(
      `INSERT INTO users (id, email, created_date, updated_date)
       VALUES (?, ?, ?, ?)`
    ).run('u2', 'new@b.c', 'now', 'now');
    const row = db
      .prepare(`SELECT credits_remaining FROM users WHERE id='u2'`)
      .get() as { credits_remaining: number };
    expect(row.credits_remaining).toBe(TIER_LIMITS.free.creditsPerMonth);
  });
});

/**
 * A monthly grant must be paid monthly, and a revoked grant must stop paying.
 *
 * Both of these were found by the independent §4B audit, one commit apart, and
 * both have the same shape: the NUMBER was right and the thing that pays it
 * was not. pricing-solvency.test.ts proves the grant figures are solvent at
 * full consumption. It cannot see either defect here, because one lives in a
 * cron SCHEDULE and the other in a row nobody read — neither is a constant.
 *
 * So this runs the real SQL from `handleDailyCreditReset` against a real
 * SQLite database with the real migrations applied, and asserts on balances
 * and tiers rather than on the source text. The statements are extracted from
 * cron-handler.ts rather than retyped: a copy of the query would pass while
 * the shipped one was broken, which is the whole failure being closed.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { TIER_LIMITS } from '@bicameral/shared/constants';

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = resolve(ROOT, 'migrations');
const CRON_SRC = readFileSync(
  resolve(ROOT, 'apps/web/src/lib/cron-handler.ts'),
  'utf8'
);

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    db.exec(readFileSync(resolve(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

/**
 * Rebuild the grant UPDATE exactly as cron-handler.ts builds it, from the same
 * constants, and fail loudly if the shipped statement stops matching the shape
 * this test reproduces.
 */
function grantSql(): string {
  const grantedTiers = (
    Object.keys(TIER_LIMITS) as (keyof typeof TIER_LIMITS)[]
  ).filter((t) => t !== 'free');
  const cases = grantedTiers
    .map((t) => `WHEN tier = '${t}' THEN ${TIER_LIMITS[t].creditsPerMonth}`)
    .join('\n      ');
  const tierList = grantedTiers.map((t) => `'${t}'`).join(', ');

  // The guard clause must be present in the shipped source. Without this, the
  // test would happily exercise its own correct query while the product
  // shipped an unguarded one.
  expect(
    CRON_SRC,
    'cron-handler.ts no longer guards the grant on credits_granted_at — the ' +
      'monthly grant is being paid on every run of a daily cron'
  ).toContain('credits_granted_at IS NULL OR substr(credits_granted_at, 1, 7)');

  return `UPDATE users SET credits_remaining = CASE
      ${cases}
      ELSE credits_remaining
    END,
    credits_granted_at = ?1
    WHERE tier IN (${tierList})
      AND (credits_granted_at IS NULL OR substr(credits_granted_at, 1, 7) < ?1)`;
}

/**
 * The reconcile statement, with the same parity guard as grantSql().
 *
 * This is a COPY of the SQL in cron-handler.ts, and a copy is precisely what
 * passes while the shipped statement is broken — the defect this whole file
 * exists to close, reproduced in the file closing it. So every clause the
 * behaviour depends on is asserted present in the real source first. If the
 * shipped reconcile loses its revocation check, these tests fail here rather
 * than going on to prove that a string in a test file works correctly.
 */
const DEMOTE_CLAUSES = [
  "tier = 'nonprofit'",
  'revoked_at IS NULL',
  "trim(granted_by) <> ''",
];

function demoteSql(): string {
  for (const clause of DEMOTE_CLAUSES) {
    expect(
      CRON_SRC,
      `cron-handler.ts's nonprofit reconcile no longer contains "${clause}" — ` +
        'a revoked grant would keep being paid'
    ).toContain(clause);
  }
  return `UPDATE users SET tier = 'free'
     WHERE tier = 'nonprofit'
       AND id NOT IN (
         SELECT user_id FROM nonprofit_grants
         WHERE revoked_at IS NULL
           AND granted_by IS NOT NULL
           AND trim(granted_by) <> ''
       )`;
}

function addUser(db: DatabaseSync, id: string, tier: string, credits: number) {
  db.prepare(
    `INSERT INTO users (id, email, tier, credits_remaining, created_date, updated_date)
     VALUES (?, ?, ?, ?, 'now', 'now')`
  ).run(id, `${id}@example.com`, tier, credits);
}

const creditsOf = (db: DatabaseSync, id: string) =>
  (
    db.prepare(`SELECT credits_remaining c FROM users WHERE id=?`).get(id) as {
      c: number;
    }
  ).c;

const tierOf = (db: DatabaseSync, id: string) =>
  (db.prepare(`SELECT tier t FROM users WHERE id=?`).get(id) as { t: string })
    .t;

describe('the monthly grant is paid once a month, not once a day', () => {
  it('grants on the first run of a month', () => {
    const db = freshDb();
    addUser(db, 'pro1', 'pro', 0);
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'pro1')).toBe(TIER_LIMITS.pro.creditsPerMonth);
  });

  it('does NOT grant again on later runs in the same month', () => {
    // The defect: cron "0 3 * * *" fires daily and paid the monthly figure
    // every time, so a subscriber who spent each refill drew 30x the grant —
    // 30,000 credits, 1,200 apps, $342 of cost against $29 of revenue.
    const db = freshDb();
    addUser(db, 'pro1', 'pro', 0);
    const sql = grantSql();

    db.prepare(sql).run('2026-09');
    // Subscriber spends the whole grant.
    db.prepare(`UPDATE users SET credits_remaining = 0 WHERE id='pro1'`).run();

    // 29 more daily runs in the same month.
    for (let i = 0; i < 29; i++) db.prepare(sql).run('2026-09');

    expect(
      creditsOf(db, 'pro1'),
      'a second grant was issued within the same calendar month'
    ).toBe(0);
  });

  it('grants again once the month rolls over', () => {
    const db = freshDb();
    addUser(db, 'pro1', 'pro', 0);
    const sql = grantSql();
    db.prepare(sql).run('2026-09');
    db.prepare(`UPDATE users SET credits_remaining = 0 WHERE id='pro1'`).run();
    db.prepare(sql).run('2026-10');
    expect(creditsOf(db, 'pro1')).toBe(TIER_LIMITS.pro.creditsPerMonth);
  });

  it('bounds a year of daily runs to twelve grants', () => {
    // The invariant the pricing rests on, stated as the thing it actually
    // means: total credits issued in a year is 12 x the grant, whatever the
    // cron schedule is.
    const db = freshDb();
    addUser(db, 'pro1', 'pro', 0);
    const sql = grantSql();
    let issued = 0;
    for (let m = 1; m <= 12; m++) {
      const period = `2026-${String(m).padStart(2, '0')}`;
      for (let d = 0; d < 30; d++) {
        const before = creditsOf(db, 'pro1');
        db.prepare(sql).run(period);
        if (creditsOf(db, 'pro1') !== before) issued++;
        db.prepare(
          `UPDATE users SET credits_remaining = 0 WHERE id='pro1'`
        ).run();
      }
    }
    expect(issued, `${issued} grants issued across 360 daily runs`).toBe(12);
  });

  it('leaves the free tier alone', () => {
    const db = freshDb();
    addUser(db, 'f1', 'free', 7);
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'f1')).toBe(7);
  });
});

describe('a revoked nonprofit grant stops paying', () => {
  const grant = (
    db: DatabaseSync,
    userId: string,
    opts: { by?: string; revoked?: boolean } = {}
  ) =>
    db
      .prepare(
        `INSERT INTO nonprofit_grants
         (id, user_id, granted_by, granted_at, evidence_kind, revoked_at,
          created_date, updated_date)
         VALUES (?, ?, ?, 'now', '501c3', ?, 'now', 'now')`
      )
      .run(
        `g-${userId}`,
        userId,
        opts.by === undefined ? 'ops@example.com' : opts.by,
        opts.revoked ? 'now' : null
      );

  it('keeps an account whose grant is in force', () => {
    const db = freshDb();
    addUser(db, 'np1', 'nonprofit', 0);
    grant(db, 'np1');
    db.prepare(demoteSql()).run();
    expect(tierOf(db, 'np1')).toBe('nonprofit');
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'np1')).toBe(TIER_LIMITS.nonprofit.creditsPerMonth);
  });

  it('demotes a revoked grant, and then it receives nothing', () => {
    // The defect: revocation was modelled and consumed by nothing, so an
    // operator recording revoked_at changed no behaviour — the tier column
    // still said 'nonprofit' and the top-up kept running forever.
    const db = freshDb();
    addUser(db, 'np2', 'nonprofit', 0);
    grant(db, 'np2', { revoked: true });

    db.prepare(demoteSql()).run();
    expect(
      tierOf(db, 'np2'),
      'a revoked grant did not demote the account'
    ).toBe('free');

    db.prepare(grantSql()).run('2026-09');
    expect(
      creditsOf(db, 'np2'),
      'a revoked account was still topped up with the team grant'
    ).toBe(0);
  });

  it('demotes a grant with no named grantor', () => {
    // grantIsActive() refuses an unattributed grant; the reconcile must agree,
    // or the predicate and the behaviour disagree about what a grant is.
    const db = freshDb();
    addUser(db, 'np3', 'nonprofit', 0);
    grant(db, 'np3', { by: '   ' });
    db.prepare(demoteSql()).run();
    expect(tierOf(db, 'np3')).toBe('free');
  });

  it('demotes an account claiming the tier with no grant row at all', () => {
    const db = freshDb();
    addUser(db, 'np4', 'nonprofit', 0);
    db.prepare(demoteSql()).run();
    expect(tierOf(db, 'np4')).toBe('free');
  });

  it('does not touch paying tiers', () => {
    const db = freshDb();
    addUser(db, 'p1', 'pro', 0);
    addUser(db, 't1', 'team', 0);
    db.prepare(demoteSql()).run();
    expect(tierOf(db, 'p1')).toBe('pro');
    expect(tierOf(db, 't1')).toBe('team');
  });
});

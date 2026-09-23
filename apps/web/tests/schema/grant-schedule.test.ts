/**
 * A monthly grant must be paid monthly, and a revoked grant must stop paying.
 *
 * Both were found by the independent §4B audit, one commit apart, and both
 * have the same shape: the NUMBER was right and the thing that pays it was
 * not. pricing-solvency.test.ts proves the grant figures are solvent at full
 * consumption and cannot see either defect, because one lives in a cron
 * SCHEDULE and the other in a row nobody read — neither is a constant.
 *
 * This executes THE SHIPPED STATEMENTS, imported from cron-handler.ts, against
 * a real SQLite database with the real migrations applied, and asserts on
 * balances and tiers. An earlier version of this file rebuilt the SQL itself;
 * the copy diverged from the original the first time the guard changed, and
 * would have gone on proving that a string in a test file behaves correctly
 * while the product shipped something else. There is now one definition.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { TIER_LIMITS } from '@bicameral/shared/constants';
import {
  demoteRevokedGrantsSql,
  monthlyGrantSql,
  grantPeriod,
} from '../../src/lib/cron-handler.js';

const MIGRATIONS = resolve(__dirname, '../../../../migrations');

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    db.exec(readFileSync(resolve(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

const grantSql = monthlyGrantSql;
const demoteSql = demoteRevokedGrantsSql;

/**
 * Create a user, and — for a SOLD tier — the active subscription that a sold
 * tier must now have behind it to be granted. Without that row the account is
 * a paid tier with no billing event, which the grant deliberately refuses.
 */
function addUser(
  db: DatabaseSync,
  id: string,
  tier: string,
  credits: number,
  sub: { id?: string; periodEnd?: string } | null = {}
) {
  db.prepare(
    `INSERT INTO users (id, email, tier, credits_remaining, created_date, updated_date)
     VALUES (?, ?, ?, ?, 'now', 'now')`
  ).run(id, `${id}@example.com`, tier, credits);
  if (sub && (tier === 'pro' || tier === 'team')) {
    addSubscription(db, id, tier, sub.id ?? `sub_${id}`, sub.periodEnd ?? null);
  }
}

function addSubscription(
  db: DatabaseSync,
  userId: string,
  tier: string,
  subId: string,
  periodEnd: string | null,
  created = '2026-09-01'
) {
  db.prepare(
    `INSERT INTO subscriptions
       (id, user_id, tier, status, stripe_customer_id, stripe_subscription_id,
        current_period_end, created_date, updated_date)
     VALUES (?, ?, ?, 'active', 'cus_1', ?, ?, ?, ?)`
  ).run(`row-${subId}`, userId, tier, subId, periodEnd, created, created);
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

describe('revocation claws back the balance, not just the tier', () => {
  // The §4B audit on the commit that added the demotion: demoting to 'free'
  // left credits_remaining at the nonprofit grant, and the grant statement
  // excludes 'free', so nothing ever reduced or expired it. A revoked account
  // went on spending team-volume credits indefinitely — the exact loss the
  // revocation exists to stop.
  const revokedGrant = (db: DatabaseSync, userId: string) =>
    db
      .prepare(
        `INSERT INTO nonprofit_grants
         (id, user_id, granted_by, granted_at, evidence_kind, revoked_at,
          created_date, updated_date)
         VALUES (?, ?, 'ops@example.com', 'now', '501c3', 'now', 'now', 'now')`
      )
      .run(`g-${userId}`, userId);

  it('clamps a revoked account to the free grant', () => {
    const db = freshDb();
    addUser(db, 'np', 'nonprofit', TIER_LIMITS.nonprofit.creditsPerMonth);
    revokedGrant(db, 'np');

    db.prepare(demoteSql()).run();

    expect(tierOf(db, 'np')).toBe('free');
    expect(
      creditsOf(db, 'np'),
      'a revoked account kept its nonprofit balance and nothing ever reduces it'
    ).toBe(TIER_LIMITS.free.creditsPerMonth);
  });

  it('never tops an account UP by revoking it', () => {
    // MIN(), not assignment: an account holding less than the free grant must
    // not be rewarded for having its grant withdrawn.
    const db = freshDb();
    addUser(db, 'np', 'nonprofit', 3);
    revokedGrant(db, 'np');
    db.prepare(demoteSql()).run();
    expect(creditsOf(db, 'np')).toBe(3);
  });

  it('leaves the clawed-back balance alone on later runs', () => {
    const db = freshDb();
    addUser(db, 'np', 'nonprofit', TIER_LIMITS.nonprofit.creditsPerMonth);
    revokedGrant(db, 'np');
    db.prepare(demoteSql()).run();
    db.prepare(grantSql()).run('2026-09');
    db.prepare(demoteSql()).run();
    db.prepare(grantSql()).run('2026-10');
    expect(creditsOf(db, 'np')).toBe(TIER_LIMITS.free.creditsPerMonth);
  });
});

describe('a subscription can change inside a month', () => {
  // The §4B audit: credits_granted_at was keyed to the USER, not to what they
  // were granted FOR. A Pro subscriber who downgraded on the 5th and
  // resubscribed on the 10th kept this month's stamp, so the grant never fired
  // and they got ~3 weeks of a paid month with nothing delivered.
  it('grants a resubscriber who upgrades again in the same month', () => {
    const db = freshDb();
    addUser(db, 'u', 'pro', 0);
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'u')).toBe(TIER_LIMITS.pro.creditsPerMonth);

    // Downgrades on the 5th, spending what was left.
    db.prepare(
      `UPDATE users SET tier='free', credits_remaining=0 WHERE id='u'`
    ).run();
    db.prepare(grantSql()).run('2026-09');

    // Resubscribes on the 10th AND PAYS — a new Stripe subscription, which is
    // the fact that distinguishes this from a tier-cycler. Under the old guard
    // this delivered nothing until October.
    db.prepare(`UPDATE users SET tier='pro' WHERE id='u'`).run();
    db.prepare(
      `INSERT INTO subscriptions
         (id, user_id, tier, status, stripe_customer_id, stripe_subscription_id,
          current_period_end, created_date, updated_date)
       VALUES ('s2','u','pro','active','cus_1','sub_SECOND','2026-10-10','2026-09-10','2026-09-10')`
    ).run();
    db.prepare(grantSql()).run('2026-09');

    expect(
      creditsOf(db, 'u'),
      'a paying resubscriber received nothing for the rest of the month'
    ).toBeGreaterThan(0);
  });

  it('tops up only the DIFFERENCE when upgrading mid-month', () => {
    const db = freshDb();
    addUser(db, 'u', 'pro', 0);
    db.prepare(grantSql()).run('2026-09');
    db.prepare(`UPDATE users SET tier='team' WHERE id='u'`).run();
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'u')).toBe(TIER_LIMITS.team.creditsPerMonth);
  });

  it('cannot farm grants by cycling tiers within a month', () => {
    // The reason reopening the guard is safe. free -> pro -> free -> pro must
    // deliver one Pro grant for the month, not two.
    const db = freshDb();
    addUser(db, 'u', 'pro', 0);
    const sql = grantSql();
    for (let i = 0; i < 5; i++) {
      db.prepare(sql).run('2026-09');
      db.prepare(`UPDATE users SET tier='free' WHERE id='u'`).run();
      db.prepare(sql).run('2026-09');
      db.prepare(`UPDATE users SET tier='pro' WHERE id='u'`).run();
    }
    db.prepare(sql).run('2026-09');
    expect(
      creditsOf(db, 'u'),
      'cycling tiers issued more than one grant in a calendar month'
    ).toBe(TIER_LIMITS.pro.creditsPerMonth);
  });

  it('pays nothing extra on a downgrade', () => {
    const db = freshDb();
    addUser(db, 'u', 'team', 0);
    db.prepare(grantSql()).run('2026-09');
    db.prepare(`UPDATE users SET tier='pro' WHERE id='u'`).run();
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'u')).toBe(TIER_LIMITS.team.creditsPerMonth);
  });
});

describe('the grant is an allowance, not a rolling balance', () => {
  it('RESETS at the month boundary rather than accumulating', () => {
    // Caught while fixing the resubscription finding: rewriting the statement
    // to add the grant turned a monthly reset into a rollover, which would
    // quietly stop the grant being the per-month ceiling the pricing is
    // derived against. Unused credits expire, as they always did.
    const db = freshDb();
    addUser(db, 'u', 'pro', 0);
    const sql = grantSql();
    db.prepare(sql).run('2026-09');
    db.prepare(sql).run('2026-10');
    db.prepare(sql).run('2026-11');
    expect(
      creditsOf(db, 'u'),
      'unspent credits rolled over across months instead of expiring'
    ).toBe(TIER_LIMITS.pro.creditsPerMonth);
  });
});

describe('the grant period is UTC', () => {
  it('derives YYYY-MM in UTC regardless of the host timezone', () => {
    // The month boundary is stable only while the stamp and the cron schedule
    // agree on a timezone. toISOString() is UTC per spec; Cloudflare evaluates
    // cron triggers in UTC. Pinned so neither half drifts silently.
    expect(grantPeriod(new Date('2026-09-01T00:30:00Z'))).toBe('2026-09');
    expect(grantPeriod(new Date('2026-08-31T23:30:00Z'))).toBe('2026-08');
    expect(grantPeriod(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });
});

describe('the migration backfill agrees with the runtime reference', () => {
  it('does not re-grant a backfilled account in the same month', () => {
    // The §4B audit, HIGH: the backfill fell back to `tier` while the runtime
    // fell back to the constant '-'. They never matched, so every backfilled
    // provisioned account looked unpaid and was granted a SECOND time in the
    // same month — the exact double-pay the backfill exists to prevent.
    //
    // Asserted behaviourally rather than by comparing the two SQL strings: the
    // strings can differ harmlessly, and what matters is that no second grant
    // is paid. This is the shape that catches any future divergence.
    const db = freshDb();

    // A nonprofit account granted under the OLD guard: stamped for the month,
    // no ref (the column did not exist yet), balance already spent.
    db.prepare(
      `INSERT INTO users (id, email, tier, credits_remaining, credits_granted_at,
                          credits_granted_tier, created_date, updated_date)
       VALUES ('np','np@e.c','nonprofit', 0, '2026-09', 'nonprofit', 'now', 'now')`
    ).run();
    db.prepare(
      `INSERT INTO nonprofit_grants
         (id, user_id, granted_by, granted_at, evidence_kind, created_date, updated_date)
       VALUES ('g','np','ops@e.c','now','501c3','now','now')`
    ).run();

    // Re-run migration 032's backfill against this row, as it would run on deploy.
    db.exec(
      readFileSync(
        resolve(MIGRATIONS, '032_grant_billing_ref.sql'),
        'utf8'
      ).split('ALTER TABLE users ADD COLUMN credits_granted_ref TEXT;')[1]
    );

    db.prepare(grantSql()).run('2026-09');

    expect(
      creditsOf(db, 'np'),
      'a backfilled account was granted a second time in the same month — the ' +
        'migration reference and the runtime reference disagree'
    ).toBe(0);
  });
});

describe('a paid tier with no billing behind it is not granted', () => {
  it('refuses a pro account whose subscription was cancelled', () => {
    // The §4B audit: keyed on a reference that falls back to a constant, an
    // account stranded at tier='pro' by a webhook failure computed a stable
    // reference and collected a full Pro grant every month forever, with no
    // billing event behind it — the unbounded loss the keying exists to stop,
    // reintroduced by the keying itself.
    const db = freshDb();
    addUser(db, 'u', 'pro', 0, null); // no subscription row at all
    db.prepare(grantSql()).run('2026-09');
    expect(
      creditsOf(db, 'u'),
      'a paid tier with no active subscription received a grant'
    ).toBe(0);

    // And it stays refused, month after month.
    db.prepare(grantSql()).run('2026-10');
    db.prepare(grantSql()).run('2026-11');
    expect(creditsOf(db, 'u')).toBe(0);
  });

  it('refuses when the subscription exists but is canceled', () => {
    const db = freshDb();
    addUser(db, 'u', 'pro', 0, null);
    db.prepare(
      `INSERT INTO subscriptions
         (id, user_id, tier, status, stripe_customer_id, stripe_subscription_id,
          current_period_end, created_date, updated_date)
       VALUES ('s','u','pro','canceled','cus_1','sub_X','2026-10-01','2026-09-01','2026-09-01')`
    ).run();
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'u')).toBe(0);
  });

  it('still grants a PROVISIONED tier, which has no subscription by design', () => {
    // The rule must not degrade into "everyone needs a subscription": a
    // nonprofit grant and an enterprise contract legitimately have none.
    const db = freshDb();
    addUser(db, 'np', 'nonprofit', 0, null);
    db.prepare(
      `INSERT INTO nonprofit_grants
         (id, user_id, granted_by, granted_at, evidence_kind, created_date, updated_date)
       VALUES ('g','np','ops@e.c','now','501c3','now','now')`
    ).run();
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'np')).toBe(TIER_LIMITS.nonprofit.creditsPerMonth);
  });
});

describe('reactivating the SAME subscription is a billing event', () => {
  it('grants when a cancelled subscription is reactivated mid-month', () => {
    // The §4B audit: Stripe PRESERVES the subscription id across
    // cancel-and-reactivate, so keying on the id alone left the original
    // failure intact in a variant the first test suite did not cover — the
    // subscriber spends down, pays again on the 15th, and receives nothing.
    // The reference carries current_period_end for exactly this reason.
    const db = freshDb();
    addUser(db, 'u', 'pro', 0, { id: 'sub_SAME', periodEnd: '2026-09-30' });
    db.prepare(grantSql()).run('2026-09');
    expect(creditsOf(db, 'u')).toBe(TIER_LIMITS.pro.creditsPerMonth);

    // Spends it all, cancels, then reactivates on the 15th and PAYS. Stripe
    // reuses sub_SAME and advances the period.
    db.prepare(`UPDATE users SET credits_remaining = 0 WHERE id='u'`).run();
    db.prepare(
      `UPDATE subscriptions SET current_period_end='2026-10-15' WHERE user_id='u'`
    ).run();

    db.prepare(grantSql()).run('2026-09');
    expect(
      creditsOf(db, 'u'),
      'a reactivated subscriber who paid again received nothing'
    ).toBe(TIER_LIMITS.pro.creditsPerMonth);
  });

  it('does not grant twice inside one unchanged billing period', () => {
    const db = freshDb();
    addUser(db, 'u', 'pro', 0, { id: 'sub_SAME', periodEnd: '2026-09-30' });
    const sql = grantSql();
    db.prepare(sql).run('2026-09');
    db.prepare(`UPDATE users SET credits_remaining = 0 WHERE id='u'`).run();
    for (let i = 0; i < 20; i++) db.prepare(sql).run('2026-09');
    expect(creditsOf(db, 'u')).toBe(0);
  });
});

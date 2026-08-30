/**
 * Dedicated QA-loop test tenant.
 *
 * apps/web/src/lib/virtual-key.ts's `issueVirtualKeyIfMissing()` only runs
 * inside a live Worker request after a real Better Auth session exists
 * (GitHub OAuth or verified email/password sign-in — see routes/auth.ts).
 * Scripting a full OAuth handshake just to mint one throwaway key is out of
 * scope for a QA harness and would be its own source of flakiness.
 *
 * Instead, this module reuses the EXACT SAME key scheme
 * (crypto.randomUUID() raw key, SHA-256 hex hash stored in `users.virtual_key`,
 * never the raw key persisted — see virtual-key.ts's sha256Hex/
 * issueVirtualKeyIfMissing docstrings) and inserts the row directly into the
 * local D1 users table via `wrangler d1 execute --local`. This is the local
 * dev database only (see util/d1.ts) — never production. The row is
 * clearly tagged (email domain, id prefix) and deleted at the end of every
 * run, pass or fail.
 */
import { createHash, randomUUID } from 'node:crypto';
import { d1Query, d1Rows } from './util/d1.ts';

const TEST_USER_ID_PREFIX = 'qaloop-';
const TEST_EMAIL_DOMAIN = 'qa-loop.bicameral.invalid';

export interface TestTenant {
  userId: string;
  email: string;
  rawVirtualKey: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Creates a fresh, isolated test user + virtual key in local D1. Tier is
 * 'pro' (not 'free') so the pipeline-simulation check isn't blocked by
 * free-tier rate limits mid-run; credits_remaining is set generously since
 * this harness's own $1/$5 caps are the real budget control, not D1 credits. */
export async function createTestTenant(): Promise<TestTenant> {
  const userId = `${TEST_USER_ID_PREFIX}${randomUUID()}`;
  const email = `${userId}@${TEST_EMAIL_DOMAIN}`;
  const rawVirtualKey = randomUUID();
  const hashedKey = sha256Hex(rawVirtualKey);
  const now = new Date().toISOString();

  await d1Query(
    `INSERT INTO users (id, email, full_name, role, tier, virtual_key, credits_remaining, credits_used, is_banned, trial_expires_at, created_date, updated_date, created_by) ` +
      `VALUES ('${userId}', '${email}', 'QA Loop Synthetic Founder', 'user', 'pro', '${hashedKey}', 100000, 0, 0, NULL, '${now}', '${now}', 'qa-loop')`
  );

  return { userId, email, rawVirtualKey };
}

/** Best-effort cleanup — deletes the tenant and anything it created
 * (pipeline runs/steps/blueprints/generations cascade manually since D1
 * has no ON DELETE CASCADE configured in migrations/001_init.sql). Safe to
 * call even if some rows were never created. */
export async function destroyTestTenant(userId: string): Promise<void> {
  const runs = await d1Rows<{ id: string }>(
    `SELECT id FROM pipeline_runs WHERE user_id = '${userId}'`
  );
  for (const run of runs) {
    await d1Query(
      `DELETE FROM pipeline_steps WHERE pipeline_run_id = '${run.id}'`
    );
    await d1Query(`DELETE FROM blueprints WHERE pipeline_run_id = '${run.id}'`);
    await d1Query(
      `DELETE FROM generations WHERE pipeline_run_id = '${run.id}'`
    );
    await d1Query(
      `DELETE FROM research_queries WHERE pipeline_run_id = '${run.id}'`
    );
  }
  await d1Query(`DELETE FROM pipeline_runs WHERE user_id = '${userId}'`);
  await d1Query(`DELETE FROM projects WHERE user_id = '${userId}'`);
  await d1Query(`DELETE FROM credit_ledger WHERE user_id = '${userId}'`);
  await d1Query(`DELETE FROM users WHERE id = '${userId}'`);
}

/** Sweeps any orphaned qa-loop tenants from prior interrupted runs (e.g. a
 * crashed harness that never reached cleanup). Run at the start of every
 * invocation so local D1 doesn't accumulate synthetic founders indefinitely. */
export async function sweepOrphanedTestTenants(): Promise<number> {
  const orphans = await d1Rows<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE '%@${TEST_EMAIL_DOMAIN}'`
  );
  for (const orphan of orphans) {
    await destroyTestTenant(orphan.id);
  }
  return orphans.length;
}

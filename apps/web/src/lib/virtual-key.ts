/**
 * Virtual Key Proxy — UUID-based API keys, tier-based rate limits, credit
 * tracking, and 30-day trial auto-expiration.
 *
 * See @agent_docs/security.md:
 *   - Virtual Key: UUID v4 (122 bits), stored hashed in D1 (SHA-256, never
 *     the raw key — brute force mitigation).
 *   - Rate limiting: sliding window in D1, per-key tracking.
 *   - Trial expiration: 30-day auto-expiry via D1 timestamp check on every
 *     request.
 */
import { RATE_LIMITS, SIM_EVOLVED } from '@bicameral/shared/constants';
import type { SubscriptionTier } from '@bicameral/shared/types';

const TRIAL_DAYS = 30;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time string comparison for shared-secret webhook checks (e.g.
 * `x-fluxy-api-key`, `x-webhook-secret`) — same rationale as
 * lib/stripe.ts's `verifyStripeSignature`: a naive `===` on a secret leaks
 * timing information proportional to the matching-prefix length, letting an
 * attacker recover the secret byte-by-byte. Lengths are compared first
 * (safe to leak — it's not secret-dependent), then every byte is compared
 * unconditionally via XOR-accumulation so early mismatches don't short
 * -circuit the loop. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Mints a virtual key for a user who doesn't have one yet. Returns the raw
 * key exactly once — only the SHA-256 hash is persisted. */
export async function issueVirtualKeyIfMissing(
  db: D1Database,
  userId: string
): Promise<string | null> {
  const existing = await db
    .prepare('SELECT virtual_key FROM users WHERE id = ?')
    .bind(userId)
    .first<{ virtual_key: string | null }>();

  if (existing?.virtual_key) return null;

  const rawKey = crypto.randomUUID();
  const hashed = await sha256Hex(rawKey);
  const now = new Date().toISOString();
  const trialExpiresAt = new Date(
    Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  await db
    .prepare(
      'UPDATE users SET virtual_key = ?, trial_expires_at = ?, updated_date = ? WHERE id = ?'
    )
    .bind(hashed, trialExpiresAt, now, userId)
    .run();

  return rawKey;
}

export interface VirtualKeyLookup {
  userId: string;
  tier: SubscriptionTier;
  isBanned: boolean;
  trialExpired: boolean;
  creditsRemaining: number;
}

/** Resolves a raw virtual key (e.g. from an `Authorization: Bearer <key>`
 * header) to its owning user, evaluating ban + trial-expiry state. */
export async function resolveVirtualKey(
  db: D1Database,
  rawKey: string
): Promise<VirtualKeyLookup | null> {
  const hashed = await sha256Hex(rawKey);
  const row = await db
    .prepare(
      'SELECT id, tier, is_banned, trial_expires_at, credits_remaining FROM users WHERE virtual_key = ?'
    )
    .bind(hashed)
    .first<{
      id: string;
      tier: SubscriptionTier;
      is_banned: number;
      trial_expires_at: string | null;
      credits_remaining: number;
    }>();

  if (!row) return null;

  const trialExpired =
    row.tier === 'free' &&
    !!row.trial_expires_at &&
    new Date(row.trial_expires_at) < new Date();

  return {
    userId: row.id,
    tier: row.tier,
    isBanned: !!row.is_banned,
    trialExpired,
    creditsRemaining: row.credits_remaining,
  };
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/** Sliding-window (1hr bucket) rate limit check, tier-based caps. Bucketed
 * by hour-of-epoch so the D1 row count stays bounded without a cron sweep
 * mid-window; the daily cron (wrangler.toml) prunes old rows.
 *
 * Two-step atomic sequence (see migrations/006_rate_limit_race_fix.sql for
 * why this replaced a check-then-act SELECT+INSERT/UPDATE, which let
 * concurrent requests each read "no row yet" and insert their own counter —
 * confirmed exploitable locally: 80 concurrent requests against a 50/hour
 * free-tier key all returned 200):
 *   1. `INSERT ... ON CONFLICT DO NOTHING` establishes exactly one row for
 *      this (key, window) pair — safe under concurrent first-requests
 *      because the UNIQUE index makes D1 arbitrate conflicting inserts.
 *   2. An UPDATE guarded by `WHERE request_count < limit` (the same atomic
 *      pattern debitCredits() uses for balances) — only requests that land
 *      while genuinely under the limit succeed; simultaneous requests can't
 *      all pass on a stale read because each UPDATE re-checks the live row. */
export async function checkRateLimit(
  db: D1Database,
  virtualKeyHash: string,
  tier: SubscriptionTier
): Promise<RateLimitResult> {
  const limit = RATE_LIMITS[tier].requestsPerHour;
  const windowStart = new Date(
    Math.floor(Date.now() / 3_600_000) * 3_600_000
  ).toISOString();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO rate_limit_windows (id, virtual_key, window_start, request_count, created_date, updated_date)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(virtual_key, window_start) DO NOTHING`
    )
    .bind(crypto.randomUUID(), virtualKeyHash, windowStart, now, now)
    .run();

  const updated = await db
    .prepare(
      `UPDATE rate_limit_windows
       SET request_count = request_count + 1, updated_date = ?
       WHERE virtual_key = ? AND window_start = ? AND request_count < ?
       RETURNING request_count`
    )
    .bind(now, virtualKeyHash, windowStart, limit)
    .first<{ request_count: number }>();

  if (!updated) {
    const retryAfterSeconds = Math.ceil(
      (new Date(windowStart).getTime() + 3_600_000 - Date.now()) / 1000
    );
    return { allowed: false, limit, remaining: 0, retryAfterSeconds };
  }

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - updated.request_count),
    retryAfterSeconds: 0,
  };
}

/** Atomically debits credits (WHERE guard prevents negative balances under
 * concurrent requests — see @agent_docs/security.md "Atomic debit"). */
export async function debitCredits(
  db: D1Database,
  userId: string,
  amount: number
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      'UPDATE users SET credits_remaining = credits_remaining - ?, credits_used = credits_used + ?, updated_date = ? WHERE id = ? AND credits_remaining >= ?'
    )
    .bind(amount, amount, now, userId, amount)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Credits a user's balance and writes the matching `credit_ledger` row in
 * one batch (D1's closest thing to a transaction across two statements) —
 * used by routes/billing.ts's Stripe webhook handler when a credit-pack
 * checkout completes. `amount` is a positive integer (credits added). */
export async function creditUserCredits(
  db: D1Database,
  userId: string,
  amount: number,
  ledger: {
    type: 'credit' | 'trial' | 'admin_adjustment';
    description?: string;
    createdBy?: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        'UPDATE users SET credits_remaining = credits_remaining + ?, updated_date = ? WHERE id = ?'
      )
      .bind(amount, now, userId),
    db
      .prepare(
        'INSERT INTO credit_ledger (id, user_id, amount, type, description, pipeline_run_id, created_date, created_by) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'
      )
      .bind(
        crypto.randomUUID(),
        userId,
        amount,
        ledger.type,
        ledger.description ?? null,
        now,
        ledger.createdBy ?? null
      ),
  ]);
}

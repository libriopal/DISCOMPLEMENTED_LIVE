/**
 * Entitlements — per-feature access gating with 6-level precedence.
 * See 04_DATA_SCHEMA_CONTRACT/schema-contract.yaml §entitlements.
 */
import type { Env } from '../env.js';

export interface Entitlement {
  id: string;
  user_id: string;
  feature: string;
  access: 'allow' | 'deny' | 'degrade';
  reason: string | null;
  actor_type: string;
  actor_id: string | null;
  expires_at: string | null;
  created_date: string;
  updated_date: string;
}

export interface EntitlementCheck {
  access: 'allow' | 'deny' | 'degrade';
  reason: string;
  level: number;
}

const PAID_TIERS = ['pro', 'team', 'enterprise'];

/**
 * Check entitlement for a user+feature using 6-level precedence:
 * 1. ACCOUNT_HARD_BLOCK (users.is_banned = 1) → deny
 * 2. SECURITY_DENY (entitlements.access='deny', reason='security') → deny
 * 3. ADMIN_DENY (entitlements.access='deny', reason='admin') → deny
 * 4. EXPLICIT_ENTITLEMENT (entitlements row exists) → as specified
 * 5. TIER_POLICY (user's tier) → allow/deny based on tier
 * 6. DEFAULT_DENY → deny
 */
export async function checkEntitlement(
  db: D1Database,
  userId: string,
  feature: string
): Promise<EntitlementCheck> {
  // Level 1: Account hard block
  const user = await db
    .prepare('SELECT is_banned, tier FROM users WHERE id = ?')
    .bind(userId)
    .first<{ is_banned: number; tier: string }>();

  if (!user) return { access: 'deny', reason: 'user_not_found', level: 1 };
  if (user.is_banned) return { access: 'deny', reason: 'ACCOUNT_HARD_BLOCK', level: 1 };

  // Levels 2-4: Check explicit entitlement
  const ent = await db
    .prepare(
      `SELECT access, reason, expires_at FROM entitlements
       WHERE user_id = ? AND feature = ?`
    )
    .bind(userId, feature)
    .first<{ access: string; reason: string; expires_at: string | null }>();

  if (ent) {
    // Check if expired
    if (ent.expires_at && new Date(ent.expires_at) < new Date()) {
      // Entitlement expired, fall through to tier policy
    } else if (ent.access === 'deny' && ent.reason === 'security') {
      return { access: 'deny', reason: 'SECURITY_DENY', level: 2 };
    } else if (ent.access === 'deny' && ent.reason === 'admin') {
      return { access: 'deny', reason: 'ADMIN_DENY', level: 3 };
    } else {
      return {
        access: ent.access as 'allow' | 'deny' | 'degrade',
        reason: 'EXPLICIT_ENTITLEMENT',
        level: 4,
      };
    }
  }

  // Level 5: Tier policy — paid users get allow, free users get deny
  if (PAID_TIERS.includes(user.tier)) {
    return { access: 'allow', reason: 'TIER_POLICY', level: 5 };
  }

  // Level 6: Default deny
  return { access: 'deny', reason: 'DEFAULT_DENY', level: 6 };
}

/**
 * Set or update an entitlement for a user+feature.
 */
export async function setEntitlement(
  db: D1Database,
  userId: string,
  feature: string,
  access: 'allow' | 'deny' | 'degrade',
  reason: string,
  actorType: 'admin' | 'system' | 'tripwire',
  actorId: string
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .prepare('SELECT id FROM entitlements WHERE user_id = ? AND feature = ?')
    .bind(userId, feature)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE entitlements SET access = ?, reason = ?, actor_type = ?, actor_id = ?, updated_date = ? WHERE id = ?`
      )
      .bind(access, reason, actorType, actorId, now, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO entitlements (id, user_id, feature, access, reason, actor_type, actor_id, created_date, updated_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), userId, feature, access, reason, actorType, actorId, now, now)
      .run();
  }
}

/**
 * List all entitlements for a user.
 */
export async function listEntitlements(
  db: D1Database,
  userId: string
): Promise<Entitlement[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM entitlements WHERE user_id = ? ORDER BY created_date DESC`
    )
    .bind(userId)
    .all<Entitlement>();
  return results;
}

/**
 * Auto-grant an entitlement if:
 * 1. The denial source is TIER_POLICY (level 5)
 * 2. The user's tier is paid (pro, team, enterprise)
 * 3. No higher-precedence deny exists (levels 1-4 all pass)
 */
export async function autoGrantIfEligible(
  db: D1Database,
  userId: string,
  feature: string
): Promise<boolean> {
  const check = await checkEntitlement(db, userId, feature);

  if (check.level === 5 && check.access === 'allow') {
    // Already allowed by tier policy — grant explicit entitlement
    await setEntitlement(db, userId, feature, 'allow', 'tier_policy', 'system', 'auto_grant');
    return true;
  }

  return false;
}

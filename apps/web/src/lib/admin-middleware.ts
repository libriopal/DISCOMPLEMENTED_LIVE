/**
 * Admin permission middleware — checks `users.admin_level` against the
 * tier required by a route. See @agent_docs/admin-panel.md "Permission
 * Tiers": -read < -write < -full, each a superset of the one before.
 * Mounted per-route (not globally) so each admin route declares its own
 * floor via `requireAdmin('-read' | '-write' | '-full')`.
 */
import { createMiddleware } from 'hono/factory';
import { BicameralError } from '@bicameral/shared/errors';
import type { AdminPermissionLevel } from '@bicameral/shared/types';
import type { Env } from '../env.js';
import type { AuthVariables } from './require-auth.js';

const LEVEL_RANK: Record<AdminPermissionLevel, number> = {
  '-read': 0,
  '-write': 1,
  '-full': 2,
};

export interface AdminVariables extends AuthVariables {
  adminLevel: AdminPermissionLevel;
}

export function requireAdmin(minLevel: AdminPermissionLevel) {
  return createMiddleware<{ Bindings: Env; Variables: AdminVariables }>(
    async (c, next) => {
      const userId = c.get('userId');
      const user = await c.env.DB.prepare(
        'SELECT admin_level FROM users WHERE id = ?'
      )
        .bind(userId)
        .first<{ admin_level: AdminPermissionLevel | null }>();

      // 403, not 401. requireAuth has already run and established who this
      // is; the answer here is "you, specifically, may not", which is a
      // different fact from "I do not know who you are" and leads a caller to
      // a different next step — a 401 invites a re-login that cannot help.
      // packages/admin/tests/security/auth.test.ts already states 403 as the
      // acceptance criterion for an unprivileged caller; this middleware was
      // the one place answering 401 instead.
      const adminLevel = user?.admin_level ?? null;
      if (!adminLevel) {
        throw new BicameralError(
          'Admin access required',
          'ADMIN_REQUIRED',
          403
        );
      }
      if (LEVEL_RANK[adminLevel] < LEVEL_RANK[minLevel]) {
        throw new BicameralError(
          `Requires ${minLevel} admin access or higher`,
          'ADMIN_TIER_INSUFFICIENT',
          403
        );
      }

      c.set('adminLevel', adminLevel);
      return next();
    }
  );
}

/** Every caller `await`s this after its actual mutation has already
 * committed (ban applied, shutdown flag set, etc.) — so a failure here
 * must not throw into the route handler and turn a successful admin
 * action into a 500 the admin then retries. Logged to console instead;
 * losing one audit row is a lesser problem than a false-failure retry
 * loop on a destructive action. */
export async function logAdminAction(
  db: D1Database,
  adminUserId: string,
  action: string,
  target: string | null,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO security_events (id, event_type, severity, ip_address, user_id, route, details, created_date)
         VALUES (?, 'admin_action', 'low', NULL, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        adminUserId,
        action,
        JSON.stringify({ target, ...details }),
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    console.error('logAdminAction failed', {
      adminUserId,
      action,
      target,
      err,
    });
  }
}

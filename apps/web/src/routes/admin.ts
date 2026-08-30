/**
 * Admin — "Task Manager" panel backend. 15 routes across health metrics,
 * security events, bottlenecks, recommendations, user management,
 * maintenance/emergency controls, sandbox kill, data export, and pipeline
 * monitoring. See @agent_docs/admin-panel.md and @agent_docs/api-spec.md
 * "Admin". Every route is gated by requireAdmin() on top of the global
 * requireAuth (mounted in index.ts) — see lib/admin-middleware.ts for the
 * -read < -write < -full tier check.
 */
import { Hono } from 'hono';
import {
  BicameralError,
  AuthError,
  ValidationError,
} from '@bicameral/shared/errors';
import { TIER_LIMITS } from '@bicameral/shared/constants';
import { isAdminPermissionLevel } from '@bicameral/shared/types';
import type {
  AdminPermissionLevel,
  SubscriptionTier,
} from '@bicameral/shared/types';
import type { Env } from '../env.js';
import {
  requireAdmin,
  logAdminAction,
  type AdminVariables,
} from '../lib/admin-middleware.js';
import { queryAnalyticsEngine } from '../lib/analytics-engine.js';
import { provisionSupportAgent } from '../lib/fluxychat.js';
import { SANDBOX_CONTROL_ORIGIN } from '../durable-objects/sandbox-preview.js';
import { resolveCapacity } from '../durable-objects/preview-capacity.js';
import {
  gatherPipelineStepTiming,
  gatherPipelineHealth,
  gatherActiveSandboxCount,
  gatherIpEventStats,
  gatherCreditStats,
} from '../lib/admin-stats.js';
import {
  computeRecommendations,
  type RouteStat,
} from '../lib/admin-recommendations.js';

export const adminRoutes = new Hono<{
  Bindings: Env;
  Variables: AdminVariables;
}>();

// The ceiling, read from the same place admission control reads it
// (durable-objects/PreviewCapacity.ts via resolveCapacity). It used to be a
// second hardcoded `10` here, kept in sync with wrangler.toml by a comment —
// and it was not: `max_instances` was raised to 20 and this stayed at 10, so
// the admin panel reported the platform at 8/10 when it was at 8/20, and
// `computeRecommendations` raised "approaching the sandbox ceiling" against a
// ceiling that had not existed for some time. A third mirror of one number was
// the defect; this reads the one that is authoritative.

interface OverallRequestStats {
  requestsPerHour: number;
  avgDurationMs: number;
  errorRate: number;
}

async function fetchOverallRequestStats(
  env: Env
): Promise<OverallRequestStats | null> {
  const result = await queryAnalyticsEngine(
    env,
    `SELECT count() AS requests,
            avg(double1) AS avg_duration,
            sum(if(double2 >= 500, 1, 0)) / count() AS error_rate
     FROM bicameral_metrics
     WHERE timestamp > NOW() - INTERVAL '1' HOUR`
  );
  if (!result || result.data.length === 0) return null;
  const row = result.data[0];
  return {
    requestsPerHour: Number(row.requests),
    avgDurationMs: Number(row.avg_duration),
    errorRate: Number(row.error_rate),
  };
}

async function fetchRouteStats(env: Env): Promise<RouteStat[]> {
  const result = await queryAnalyticsEngine(
    env,
    `SELECT blob1 AS route,
            quantile(0.95)(double1) AS p95,
            sum(if(double2 >= 500, 1, 0)) / count() AS error_rate
     FROM bicameral_metrics
     WHERE timestamp > NOW() - INTERVAL '1' HOUR
     GROUP BY route
     ORDER BY p95 DESC
     LIMIT 20`
  );
  if (!result) return [];
  return result.data.map((row) => ({
    route: String(row.route),
    p95Ms: Number(row.p95),
    errorRate: Number(row.error_rate),
  }));
}

// ============ GET /api/admin/metrics ============
adminRoutes.get('/metrics', requireAdmin('-read'), async (c) => {
  const [
    stepTiming,
    health,
    activeSandboxes,
    overall,
    maintenanceFlag,
    shutdownFlag,
  ] = await Promise.all([
    gatherPipelineStepTiming(c.env.DB),
    gatherPipelineHealth(c.env.DB),
    gatherActiveSandboxCount(c.env.DB),
    fetchOverallRequestStats(c.env),
    c.env.CONFIG_KV.get('MAINTENANCE_MODE'),
    c.env.CONFIG_KV.get('EMERGENCY_SHUTDOWN'),
  ]);

  const activePipelines =
    (health.byStatus.ideating ?? 0) +
    (health.byStatus.researching ?? 0) +
    (health.byStatus.designing ?? 0) +
    (health.byStatus.implementing ?? 0) +
    (health.byStatus.awaiting_approval ?? 0);

  const userCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM users'
  ).first<{ count: number }>();

  return c.json({
    requestsPerHour: overall?.requestsPerHour ?? null,
    avgRequestDurationMs: overall?.avgDurationMs ?? null,
    errorRate: overall?.errorRate ?? null,
    activeUsers: userCount?.count ?? 0,
    activeSandboxes,
    maxSandboxInstances: resolveCapacity(c.env.PREVIEW_MAX_INSTANCES),
    activePipelines,
    avgCoderIterations: health.avgCoderIterations,
    pipelineSuccessRate: health.successRate,
    pipelinesByStatus: health.byStatus,
    pipelineStepTiming: stepTiming,
    analyticsEngineConfigured: !!c.env.CF_ACCOUNT_ID,
    maintenanceMode: maintenanceFlag === 'true',
    emergencyShutdown: shutdownFlag === 'true',
  });
});

// ============ GET /api/admin/security ============
adminRoutes.get('/security', requireAdmin('-read'), async (c) => {
  const severity = c.req.query('severity');
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);

  const query = severity
    ? c.env.DB.prepare(
        'SELECT * FROM security_events WHERE severity = ? ORDER BY created_date DESC LIMIT ?'
      ).bind(severity, limit)
    : c.env.DB.prepare(
        'SELECT * FROM security_events ORDER BY created_date DESC LIMIT ?'
      ).bind(limit);

  const { results } = await query.all<{
    id: string;
    event_type: string;
    severity: string;
    ip_address: string | null;
    user_id: string | null;
    route: string | null;
    details: string | null;
    created_date: string;
  }>();

  return c.json(
    results.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      severity: r.severity,
      ipAddress: r.ip_address,
      userId: r.user_id,
      route: r.route,
      details: r.details ? JSON.parse(r.details) : null,
      createdAt: r.created_date,
    }))
  );
});

// ============ GET /api/admin/bottlenecks ============
adminRoutes.get('/bottlenecks', requireAdmin('-read'), async (c) => {
  const [routeStats, stepTiming] = await Promise.all([
    fetchRouteStats(c.env),
    gatherPipelineStepTiming(c.env.DB),
  ]);

  return c.json({
    hotRoutes: routeStats,
    pipelineStepP95: stepTiming,
    analyticsEngineConfigured: !!c.env.CF_ACCOUNT_ID,
  });
});

// ============ GET /api/admin/recommendations ============
adminRoutes.get('/recommendations', requireAdmin('-read'), async (c) => {
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [
    routeStats,
    health,
    stepTiming,
    activeSandboxes,
    wafByIp,
    failedAuthByIp,
    credits,
  ] = await Promise.all([
    fetchRouteStats(c.env),
    gatherPipelineHealth(c.env.DB),
    gatherPipelineStepTiming(c.env.DB),
    gatherActiveSandboxCount(c.env.DB),
    gatherIpEventStats(c.env.DB, 'waf_block', oneHourAgo),
    gatherIpEventStats(c.env.DB, 'auth_failed', oneHourAgo),
    gatherCreditStats(c.env.DB),
  ]);

  const architect = stepTiming.find((s) => s.agentRole === 'architect');
  const generateRoute = routeStats.find((r) => r.route === '/api/generate');

  const recommendations = computeRecommendations({
    routeStats,
    wafByIp,
    failedAuthByIp,
    activeSandboxes,
    maxSandboxInstances: resolveCapacity(c.env.PREVIEW_MAX_INSTANCES),
    usersNearCreditCap: credits.usersNearCap,
    negativeBalanceUsers: credits.negativeBalanceUsers,
    generateRouteP95Ms: generateRoute?.p95Ms ?? null,
    architectP95Ms: architect?.p95Ms ?? null,
    coderAvgIterations: health.avgCoderIterations,
    pipelineSuccessRate: health.successRate,
    blueprintRejectionRate: health.blueprintRejectionRate,
  });

  return c.json({ recommendations });
});

// ============ GET /api/admin/users ============
adminRoutes.get('/users', requireAdmin('-read'), async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, full_name, role, tier, admin_level, credits_remaining,
            credits_used, is_banned, trial_expires_at, created_date
     FROM users ORDER BY created_date DESC LIMIT ?`
  )
    .bind(limit)
    .all<{
      id: string;
      email: string;
      full_name: string | null;
      role: string;
      tier: SubscriptionTier;
      admin_level: AdminPermissionLevel | null;
      credits_remaining: number;
      credits_used: number;
      is_banned: number;
      trial_expires_at: string | null;
      created_date: string;
    }>();

  return c.json(
    results.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.full_name,
      role: u.role,
      tier: u.tier,
      adminLevel: u.admin_level,
      creditsRemaining: u.credits_remaining,
      creditsUsed: u.credits_used,
      isBanned: !!u.is_banned,
      trialExpiresAt: u.trial_expires_at,
      createdAt: u.created_date,
    }))
  );
});

// ============ PATCH /api/admin/users/:id ============
interface UserPatchBody {
  isBanned?: boolean;
  tier?: SubscriptionTier;
  creditsAdjustment?: number;
  adminLevel?: AdminPermissionLevel | null;
}

const VALID_TIERS = Object.keys(TIER_LIMITS) as SubscriptionTier[];

// This route writes admin_level and tier straight into D1 (see `sets`
// below); an unvalidated value here would corrupt more than this row — an
// invalid tier breaks TIER_LIMITS[tier] lookups app-wide (usage.ts,
// virtual-key.ts rate limiting), and an invalid admin_level makes
// requireAdmin's LEVEL_RANK lookup NaN, silently locking that admin out
// rather than granting access. JSON body from an admin client is a system
// boundary, so it gets validated here rather than trusted.
function validateUserPatchBody(body: UserPatchBody): void {
  if (body.isBanned !== undefined && typeof body.isBanned !== 'boolean') {
    throw new ValidationError('isBanned must be a boolean');
  }
  if (body.tier !== undefined && !VALID_TIERS.includes(body.tier)) {
    throw new ValidationError(`tier must be one of: ${VALID_TIERS.join(', ')}`);
  }
  if (
    body.adminLevel !== undefined &&
    body.adminLevel !== null &&
    !isAdminPermissionLevel(body.adminLevel)
  ) {
    throw new ValidationError(
      "adminLevel must be '-read', '-write', '-full', or null"
    );
  }
  if (
    body.creditsAdjustment !== undefined &&
    !Number.isFinite(body.creditsAdjustment)
  ) {
    throw new ValidationError('creditsAdjustment must be a finite number');
  }
}

adminRoutes.patch('/users/:id', requireAdmin('-write'), async (c) => {
  const targetId = c.req.param('id');
  const body = await c.req.json<UserPatchBody>();
  validateUserPatchBody(body);

  // Credit balance changes and admin-grant changes are the two highest-
  // blast-radius edits this route can make — reserve them for -full even
  // though ban/tier changes are allowed at -write. See admin-panel.md
  // "-write" vs "-full".
  if (
    (body.creditsAdjustment !== undefined || body.adminLevel !== undefined) &&
    c.get('adminLevel') !== '-full'
  ) {
    throw new AuthError(
      'Credit and admin-level changes require -full admin access',
      'ADMIN_TIER_INSUFFICIENT'
    );
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: string }>();
  if (!existing)
    throw new BicameralError('User not found', 'USER_NOT_FOUND', 404);

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.isBanned !== undefined) {
    sets.push('is_banned = ?');
    binds.push(body.isBanned ? 1 : 0);
  }
  if (body.tier !== undefined) {
    sets.push('tier = ?');
    binds.push(body.tier);
  }
  if (body.adminLevel !== undefined) {
    sets.push('admin_level = ?');
    binds.push(body.adminLevel);
  }
  if (body.creditsAdjustment !== undefined) {
    sets.push('credits_remaining = credits_remaining + ?');
    binds.push(body.creditsAdjustment);
  }

  if (sets.length === 0) {
    throw new BicameralError('No fields to update', 'VALIDATION_ERROR', 400);
  }

  sets.push('updated_date = ?');
  binds.push(new Date().toISOString());
  binds.push(targetId);

  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAdminAction(c.env.DB, c.get('userId'), 'user_patch', targetId, {
    ...body,
  });

  return c.json({ success: true });
});

// ============ POST /api/admin/maintenance ============
adminRoutes.post('/maintenance', requireAdmin('-write'), async (c) => {
  const body = await c.req.json<{ enabled: boolean }>();
  await c.env.CONFIG_KV.put(
    'MAINTENANCE_MODE',
    body.enabled ? 'true' : 'false'
  );
  await logAdminAction(
    c.env.DB,
    c.get('userId'),
    'maintenance_toggle',
    null,
    body
  );
  return c.json({ success: true, maintenanceMode: body.enabled });
});

// ============ POST /api/admin/shutdown ============
adminRoutes.post('/shutdown', requireAdmin('-full'), async (c) => {
  await c.env.CONFIG_KV.put('EMERGENCY_SHUTDOWN', 'true');

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE pipeline_runs SET status = 'error', error_message = 'Emergency shutdown', completed_at = ?, updated_date = ?
     WHERE status NOT IN ('deployed', 'error', 'paused')`
  )
    .bind(now, now)
    .run();

  await logAdminAction(c.env.DB, c.get('userId'), 'emergency_shutdown', null);
  return c.json({ success: true, shutdown: true });
});

// ============ POST /api/admin/recover ============
adminRoutes.post('/recover', requireAdmin('-full'), async (c) => {
  await c.env.CONFIG_KV.delete('EMERGENCY_SHUTDOWN');
  await logAdminAction(c.env.DB, c.get('userId'), 'emergency_recover', null);
  return c.json({ success: true, shutdown: false });
});

// ============ DELETE /api/admin/sandbox/:id ============
adminRoutes.delete('/sandbox/:id', requireAdmin('-write'), async (c) => {
  const projectId = c.req.param('id');
  const stub = c.env.PREVIEW_SANDBOX.get(
    c.env.PREVIEW_SANDBOX.idFromName(projectId)
  );
  // DELETE, not POST. The Sandbox DO has only ever handled `DELETE /destroy`;
  // a POST fell through to its proxy, was forwarded to the generated app, and
  // the resulting failure was swallowed by the `.catch()` below — so this
  // control logged a `sandbox_kill` and reported success while destroying
  // nothing. The DO now 404s an unmatched control call rather than proxying it.
  const killed = await stub
    .fetch(`${SANDBOX_CONTROL_ORIGIN}/destroy`, { method: 'DELETE' })
    .then((r) => r.ok)
    .catch(() => false);
  await logAdminAction(c.env.DB, c.get('userId'), 'sandbox_kill', projectId);
  // `success` now reports what happened. It was hardcoded true, which meant an
  // admin killing a container that refused to die was told it had worked.
  return c.json(
    killed
      ? { success: true }
      : {
          success: false,
          error: 'The sandbox did not confirm it was destroyed.',
        },
    killed ? 200 : 502
  );
});

// ============ GET /api/admin/export ============
// Excludes Better Auth internal tables (sessions/accounts/verifications) —
// accounts.access_token/refresh_token are OAuth secrets that must never
// leave the Worker, even to a -full admin's browser. See security.md
// "Admin Panel Security".
const EXPORT_TABLES = [
  'users',
  'projects',
  'pipeline_runs',
  'pipeline_steps',
  'blueprints',
  'generations',
  'lattice_nodes',
  'lattice_edges',
  'research_queries',
  'credit_ledger',
  'security_events',
] as const;
const EXPORT_ROW_CAP = 5000;

adminRoutes.get('/export', requireAdmin('-full'), async (c) => {
  const dump: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM ${table} ORDER BY created_date DESC LIMIT ${EXPORT_ROW_CAP}`
    ).all();
    dump[table] = results;
  }

  await logAdminAction(c.env.DB, c.get('userId'), 'data_export', null);
  return c.json({ exportedAt: new Date().toISOString(), tables: dump });
});

// ============ GET /api/admin/pipelines ============
adminRoutes.get('/pipelines', requireAdmin('-read'), async (c) => {
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const query = status
    ? c.env.DB.prepare(
        `SELECT r.*, u.email as user_email FROM pipeline_runs r
         JOIN users u ON u.id = r.user_id
         WHERE r.status = ? ORDER BY r.updated_date DESC LIMIT ?`
      ).bind(status, limit)
    : c.env.DB.prepare(
        `SELECT r.*, u.email as user_email FROM pipeline_runs r
         JOIN users u ON u.id = r.user_id
         ORDER BY r.updated_date DESC LIMIT ?`
      ).bind(limit);

  const { results } = await query.all<{
    id: string;
    user_id: string;
    user_email: string;
    status: string;
    current_step: number;
    current_agent: string | null;
    gate_status: string | null;
    started_at: string;
    updated_date: string;
  }>();

  return c.json(
    results.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      status: r.status,
      currentStep: r.current_step,
      currentAgent: r.current_agent,
      gateStatus: r.gate_status,
      startedAt: r.started_at,
      updatedAt: r.updated_date,
    }))
  );
});

// ============ GET /api/admin/pipelines/:id ============
adminRoutes.get('/pipelines/:id', requireAdmin('-read'), async (c) => {
  const id = c.req.param('id');
  const run = await c.env.DB.prepare(
    `SELECT r.*, u.email as user_email FROM pipeline_runs r
     JOIN users u ON u.id = r.user_id WHERE r.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!run)
    throw new BicameralError(
      'Pipeline run not found',
      'PIPELINE_NOT_FOUND',
      404
    );

  const { results: steps } = await c.env.DB.prepare(
    'SELECT * FROM pipeline_steps WHERE pipeline_run_id = ? ORDER BY step_number ASC, created_date ASC'
  )
    .bind(id)
    .all<Record<string, unknown>>();

  return c.json({ run, steps });
});

// ============ POST /api/admin/pipelines/:id/cancel ============
adminRoutes.post('/pipelines/:id/cancel', requireAdmin('-write'), async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT id FROM pipeline_runs WHERE id = ?'
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing)
    throw new BicameralError(
      'Pipeline run not found',
      'PIPELINE_NOT_FOUND',
      404
    );

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE pipeline_runs SET status = 'error', error_message = 'Cancelled by admin', completed_at = ?, updated_date = ? WHERE id = ?"
  )
    .bind(now, now, id)
    .run();

  await logAdminAction(c.env.DB, c.get('userId'), 'pipeline_cancel', id);
  return c.json({ success: true, status: 'cancelled' });
});

// ============ POST /api/admin/chat/provision-agent ============
// (Re)creates the Cohere-backed support agent on the FluxyChat Worker —
// idempotent by handle, so safe to re-run after a system-prompt or tool
// change. See lib/fluxychat.ts and @agent_docs/live-chat.md.
adminRoutes.post('/chat/provision-agent', requireAdmin('-write'), async (c) => {
  const agent = await provisionSupportAgent(c.env);
  await logAdminAction(
    c.env.DB,
    c.get('userId'),
    'chat_agent_provision',
    agent.id
  );
  return c.json({ success: true, agent });
});

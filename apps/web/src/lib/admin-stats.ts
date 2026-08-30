/**
 * D1-backed stat gathering shared by GET /api/admin/metrics, /bottlenecks,
 * and /recommendations (routes/admin.ts) — one set of queries feeding all
 * three so the admin panel doesn't triple-query D1 per page load.
 */
import { TIER_LIMITS } from '@bicameral/shared/constants';
import type { SubscriptionTier } from '@bicameral/shared/types';
import type { IpEventStat } from './admin-recommendations.js';

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1)
  );
  return sortedAsc[idx];
}

export interface AgentStepTiming {
  agentRole: string;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  count: number;
}

/** Per-agent-role P95/P99 step duration, computed in JS since D1/SQLite has
 * no PERCENTILE_CONT. Bounded to the most recent 500 completed steps per
 * role so this stays cheap as pipeline_steps grows. */
export async function gatherPipelineStepTiming(
  db: D1Database
): Promise<AgentStepTiming[]> {
  const { results } = await db
    .prepare(
      `SELECT agent_role, duration_ms FROM pipeline_steps
       WHERE status = 'completed' AND duration_ms IS NOT NULL
       ORDER BY created_date DESC LIMIT 2000`
    )
    .all<{ agent_role: string; duration_ms: number }>();

  const byRole = new Map<string, number[]>();
  for (const row of results) {
    const list = byRole.get(row.agent_role) ?? [];
    list.push(row.duration_ms);
    byRole.set(row.agent_role, list);
  }

  return [...byRole.entries()].map(([agentRole, durations]) => {
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      agentRole,
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      avgMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      count: sorted.length,
    };
  });
}

export interface PipelineHealth {
  byStatus: Record<string, number>;
  successRate: number | null;
  avgCoderIterations: number | null;
  blueprintRejectionRate: number | null;
}

export async function gatherPipelineHealth(
  db: D1Database
): Promise<PipelineHealth> {
  const { results: statusRows } = await db
    .prepare(
      'SELECT status, COUNT(*) as count FROM pipeline_runs GROUP BY status'
    )
    .all<{ status: string; count: number }>();

  const byStatus = Object.fromEntries(
    statusRows.map((r) => [r.status, r.count])
  );
  const terminal = (byStatus.deployed ?? 0) + (byStatus.error ?? 0);
  const successRate = terminal > 0 ? (byStatus.deployed ?? 0) / terminal : null;

  const coderIterRow = await db
    .prepare(
      `SELECT AVG(max_iter) as avg_iterations FROM (
         SELECT pipeline_run_id, MAX(iteration) as max_iter
         FROM pipeline_steps WHERE agent_role = 'coder' GROUP BY pipeline_run_id
       )`
    )
    .first<{ avg_iterations: number | null }>();

  const blueprintRow = await db
    .prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejected
       FROM blueprints WHERE version > 1 OR approved = 0`
    )
    .first<{ total: number; rejected: number }>();

  return {
    byStatus,
    successRate,
    avgCoderIterations: coderIterRow?.avg_iterations ?? null,
    blueprintRejectionRate:
      blueprintRow && blueprintRow.total > 0
        ? blueprintRow.rejected / blueprintRow.total
        : null,
  };
}

/** Proxy for "active Tier-3 sandboxes": D1 has no sandbox session registry
 * (Sandbox DO state is per-instance), so this counts pipeline runs whose
 * Coder step is actively implementing — the only phase that opens one. */
export async function gatherActiveSandboxCount(
  db: D1Database
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) as count FROM pipeline_runs WHERE status = 'implementing'"
    )
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function gatherIpEventStats(
  db: D1Database,
  eventType: string,
  sinceIso: string
): Promise<IpEventStat[]> {
  const { results } = await db
    .prepare(
      `SELECT ip_address, COUNT(*) as count FROM security_events
       WHERE event_type = ? AND created_date >= ? AND ip_address IS NOT NULL
       GROUP BY ip_address ORDER BY count DESC LIMIT 20`
    )
    .bind(eventType, sinceIso)
    .all<{ ip_address: string; count: number }>();
  return results.map((r) => ({ ipAddress: r.ip_address, count: r.count }));
}

export interface CreditStats {
  usersNearCap: { userId: string; percentUsed: number }[];
  negativeBalanceUsers: string[];
}

export async function gatherCreditStats(db: D1Database): Promise<CreditStats> {
  const { results } = await db
    .prepare('SELECT id, tier, credits_used, credits_remaining FROM users')
    .all<{
      id: string;
      tier: SubscriptionTier;
      credits_used: number;
      credits_remaining: number;
    }>();

  const usersNearCap: { userId: string; percentUsed: number }[] = [];
  const negativeBalanceUsers: string[] = [];

  for (const u of results) {
    if (u.credits_remaining < 0) negativeBalanceUsers.push(u.id);
    const cap = TIER_LIMITS[u.tier]?.creditsPerMonth ?? Infinity;
    if (Number.isFinite(cap) && cap > 0) {
      const percentUsed = u.credits_used / cap;
      if (percentUsed > 0.8) usersNearCap.push({ userId: u.id, percentUsed });
    }
  }

  usersNearCap.sort((a, b) => b.percentUsed - a.percentUsed);
  return { usersNearCap, negativeBalanceUsers };
}

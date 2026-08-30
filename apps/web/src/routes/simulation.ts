/**
 * Simulation Routes — Monte Carlo simulation results storage & admin viewing.
 *
 * IMPORTANT: This route NEVER auto-applies findings to the architecture.
 * Simulations are run out-of-band (Python, using real HuggingFace conversation
 * data) and their reports are pushed here for storage and admin review only.
 *
 * Flow:
 *   1. .github/workflows/simulation.yml runs monte_carlo_engine.py nightly
 *      against production, under the engine's own hard credit caps.
 *   2. The engine POSTs the report to /api/simulation/ingest (shared secret).
 *   3. A daily cron reads the two most recent runs and raises an alert if a
 *      new exploit class appeared, a metric moved materially, or no run
 *      landed at all. See lib/simulation-watchdog.ts.
 *   4. Admin reviews findings at GET /api/simulation/latest, /history and
 *      /alerts.
 *   5. Only when Johnathan explicitly approves, a SEPARATE manual commit
 *      applies any architecture change — this route has no write path to
 *      production config/tripwires/knobs, by design.
 *
 * Gating: every route here is `requireAdmin('-read')` or higher, on top of
 * the global requireAuth. It used to test `c.get('isAdmin')`, a context
 * variable nothing in this codebase ever sets — so the check read as false
 * for every caller including a full admin. It was unreachable in practice
 * because index.ts imported this router and never mounted it; both halves
 * are fixed together, since fixing either alone would have produced a
 * surface that 403s or a surface that 404s.
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAdmin, type AdminVariables } from '../lib/admin-middleware.js';

const simulationRoutes = new Hono<{
  Bindings: Env;
  Variables: AdminVariables;
}>();

/**
 * GET /api/simulation/latest — most recent simulation report (admin only).
 */
simulationRoutes.get('/latest', requireAdmin('-read'), async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT * FROM simulation_runs ORDER BY created_date DESC LIMIT 1`
  ).first();

  if (!row) {
    return c.json({ message: 'No simulations have been run yet.' });
  }

  return c.json(formatRun(row as Record<string, unknown>));
});

/**
 * GET /api/simulation/history — all simulation runs (admin only).
 */
simulationRoutes.get('/history', requireAdmin('-read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, run_type, status, num_bots, total_credits_simulated,
            vdr_percent, house_edge_percent, approved_by_admin,
            applied_to_architecture, created_date
     FROM simulation_runs ORDER BY created_date DESC LIMIT 50`
  ).all();

  return c.json({ runs: rows.results ?? [] });
});

/**
 * POST /api/simulation/:id/mark-reviewed — admin marks a report as reviewed.
 * This ONLY flips a bookkeeping flag. It does NOT touch architecture, tripwires,
 * knobs, or any runtime config. Applying changes always happens as a separate,
 * explicit, human-authored commit — never automatically from this endpoint.
 */
simulationRoutes.post(
  '/:id/mark-reviewed',
  requireAdmin('-write'),
  async (c) => {
    const id = c.req.param('id');
    await c.env.DB.prepare(
      `UPDATE simulation_runs SET approved_by_admin = 1 WHERE id = ?`
    )
      .bind(id)
      .run();

    return c.json({
      id,
      message:
        'Marked reviewed. No architecture changes were made — apply any changes via a separate explicit commit.',
    });
  }
);

/**
 * GET /api/simulation/alerts — what the watchdog raised (admin only).
 *
 * Unacknowledged first, then the recent acknowledged ones, because "what is
 * wrong now" and "what was wrong last week" are different questions and only
 * the first one is urgent. §3.5 item 5: a recommendation nobody sees is the
 * same as no simulation, and the same is true of an alert.
 */
simulationRoutes.get('/alerts', requireAdmin('-read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, run_id, kind, severity, summary, detail,
            acknowledged_by, acknowledged_date, created_date
     FROM simulation_alerts
     ORDER BY acknowledged_date IS NOT NULL, created_date DESC
     LIMIT 100`
  ).all<Record<string, unknown>>();

  const alerts = (rows.results ?? []).map((row) => ({
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    severity: row.severity,
    summary: row.summary,
    detail: row.detail,
    acknowledged: row.acknowledged_date !== null,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedDate: row.acknowledged_date,
    createdDate: row.created_date,
  }));

  return c.json({
    alerts,
    unacknowledged: alerts.filter((a) => !a.acknowledged).length,
  });
});

/**
 * POST /api/simulation/alerts/:id/acknowledge — a human has seen it.
 *
 * Bookkeeping only, like mark-reviewed: acknowledging an alert changes
 * nothing about the system the alert is about. Fixing it is a separate
 * human-authored commit.
 */
simulationRoutes.post(
  '/alerts/:id/acknowledge',
  requireAdmin('-write'),
  async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    await c.env.DB.prepare(
      `UPDATE simulation_alerts
       SET acknowledged_by = ?, acknowledged_date = datetime('now')
       WHERE id = ? AND acknowledged_date IS NULL`
    )
      .bind(userId ?? 'admin', id)
      .run();

    return c.json({
      id,
      message:
        'Acknowledged. Nothing about the system changed — remediation is a separate explicit commit.',
    });
  }
);

function formatRun(row: Record<string, unknown>) {
  // The engine's own credit guard status travels inside the raw report; it is
  // the answer to "what did last night cost", which §3.5 item 3 requires be
  // visible rather than inferred from a bill at the end of the month.
  const raw = safeParse<Record<string, unknown>>(row.raw_report_json, {});
  const creditStatus = (raw.credit_status ?? null) as Record<
    string,
    unknown
  > | null;

  return {
    id: row.id,
    runType: row.run_type,
    status: row.status,
    numBots: row.num_bots,
    totalCreditsSimulated: row.total_credits_simulated,
    vdrPercent: row.vdr_percent,
    houseEdgePercent: row.house_edge_percent,
    exploitsFound: safeParse<unknown[]>(row.exploits_found_json, []),
    tripwireBreakdown: safeParse<Record<string, number>>(
      row.tripwire_breakdown_json,
      {}
    ),
    recommendations: safeParse<string[]>(row.recommendations_json, []),
    creditStatus,
    approvedByAdmin: !!row.approved_by_admin,
    appliedToArchitecture: !!row.applied_to_architecture,
    createdDate: row.created_date,
  };
}

/**
 * The columns are TEXT, not JSON, and a bare `JSON.parse` on a row written by
 * something other than the ingest route turns one malformed report into a 500
 * on the admin's only view of the simulation.
 */
function safeParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export { simulationRoutes };

/**
 * VDR (Value Delivery Rate) Routes — Discomplement's "RTP display".
 *
 * GET /api/vdr         — Current VDR metrics (public, shown to users)
 * GET /api/vdr/simulate — Run Monte Carlo VDR simulation (admin only)
 * GET /api/vdr/knobs    — Current tuning knobs and their impact (admin only)
 * POST /api/vdr/tune   — Apply a tuning knob adjustment (admin only)
 *
 * This is what makes Discomplement transparent about its value delivery:
 * users can see "Your credits have an 87.3% Value Delivery Rate" —
 * the same way a slot machine displays its RTP.
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';
import { requireAdmin } from '../lib/admin-middleware.js';
import {
  calculateVDR,
  simulateVDR,
  identifyTuningKnobs,
  type ValueOutcome,
} from '../lib/value-delivery-rate.js';

type Env = {
  DB: D1Database;
  COHERE_API_KEY: string;
  YDC_API_KEY: string;
};

const vdrRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; tier: string; adminLevel: string };
}>();

/**
 * GET /api/vdr — Current Value Delivery Rate.
 *
 * Calculates VDR from pipeline_runs and pipeline_steps in the database.
 * This is the number shown to users: "87.3% of credits result in working apps."
 */
vdrRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  // Fetch user's pipeline runs
  const runs = await c.env.DB.prepare(
    `SELECT id, status, total_credits_used, started_at, updated_date
     FROM pipeline_runs
     WHERE created_by = ? OR ? = 'admin'
     ORDER BY created_date DESC
     LIMIT 500`
  )
    .bind(userId, userId)
    .all();

  if (!runs.results || runs.results.length === 0) {
    return c.json({
      vdr: 0,
      houseEdge: 100,
      message:
        'No pipeline runs yet. Start building to measure your Value Delivery Rate.',
      totalRuns: 0,
    });
  }

  // Fetch outcomes for each run
  const outcomes: ValueOutcome[] = [];
  for (const run of runs.results) {
    const r = run as Record<string, unknown>;
    const runId = r.id as string;

    // Get steps for this run
    const steps = await c.env.DB.prepare(
      `SELECT agent_role, status, output FROM pipeline_steps WHERE pipeline_run_id = ?`
    )
      .bind(runId)
      .all();

    let filesGenerated = 0;
    let tripwireHits = 0;
    let deployed = false;
    let userApproved = false;
    let retries = 0;

    for (const step of steps.results ?? []) {
      const s = step as Record<string, unknown>;
      if (s.agent_role === 'coder' && s.status === 'completed') {
        const output = s.output as string | null;
        if (output) {
          try {
            const parsed = JSON.parse(output);
            filesGenerated += parsed.files?.length ?? 0;
          } catch {
            // output not JSON, skip
          }
        }
      }
      if (s.agent_role === 'researcher') {
        const output = s.output as string | null;
        if (output) {
          try {
            const parsed = JSON.parse(output);
            tripwireHits += parsed.tripwires?.length ?? 0;
          } catch {
            // output not JSON, skip
          }
        }
      }
      if (s.status === 'retry') retries++;
    }

    // Check if deployed
    if (r.status === 'deployed') deployed = true;
    if (r.status === 'approved') userApproved = true;

    outcomes.push({
      pipelineId: runId,
      creditsSpent: r.total_credits_used as number,
      filesGenerated,
      deployed,
      userApproved,
      userSatisfied: null, // not measured yet
      tripwireHits,
      retries,
      durationSeconds: 0, // calculate from timestamps if needed
      appComplexity: filesGenerated / 20, // rough estimate
    });
  }

  const metrics = calculateVDR(outcomes);

  return c.json({
    vdr: metrics.vdr,
    houseEdge: metrics.houseEdge,
    totalCredits: metrics.totalCredits,
    valueCredits: metrics.valueCredits,
    lossCredits: metrics.lossCredits,
    totalRuns: metrics.totalRuns,
    winRuns: metrics.winRuns,
    lossRuns: metrics.lossRuns,
    variance: metrics.vvi,
    maxRun: metrics.mvr,
    confidence: metrics.confidence,
    trend: metrics.trend,
    sampleSize: metrics.sampleSize,
    // User-facing message
    message:
      metrics.vdr > 80
        ? `Excellent: ${metrics.vdr}% of your credits produce working apps.`
        : metrics.vdr > 60
          ? `Good: ${metrics.vdr}% of your credits produce working apps. Room to improve.`
          : metrics.vdr > 40
            ? `Developing: ${metrics.vdr}% value delivery rate. Tuning in progress.`
            : `Early stage: ${metrics.vdr}% value delivery rate. The system is learning.`,
  });
});

/**
 * GET /api/vdr/simulate — Run Monte Carlo VDR simulation.
 *
 * Runs N synthetic user journeys to measure the system's VDR.
 * Admin only — this is the "RTP testing lab".
 */
vdrRoutes.get('/simulate', requireAdmin('-read'), async (c) => {
  // Get current VDR as base
  const runs = await c.env.DB.prepare(
    `SELECT total_credits_used, status FROM pipeline_runs ORDER BY created_date DESC LIMIT 100`
  ).all();

  const baseOutcomes: ValueOutcome[] = (runs.results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      pipelineId: (row.id as string) ?? '',
      creditsSpent: (row.total_credits_used as number) ?? 0,
      filesGenerated: row.status === 'deployed' ? 10 : 0,
      deployed: row.status === 'deployed',
      userApproved: row.status === 'approved' || row.status === 'deployed',
      userSatisfied: null,
      tripwireHits: 0,
      retries: 0,
      durationSeconds: 0,
      appComplexity: 0.5,
    };
  });

  const baseVdr = calculateVDR(baseOutcomes).vdr;
  const result = simulateVDR(
    baseVdr || 50,
    baseOutcomes,
    1000,
    Date.now() % 100000
  );

  return c.json(result);
});

/**
 * GET /api/vdr/knobs — Current tuning knobs (admin only).
 */
vdrRoutes.get('/knobs', requireAdmin('-read'), async (c) => {
  const runs = await c.env.DB.prepare(
    `SELECT total_credits_used, status FROM pipeline_runs LIMIT 100`
  ).all();

  const outcomes: ValueOutcome[] = (runs.results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      pipelineId: '',
      creditsSpent: (row.total_credits_used as number) ?? 0,
      filesGenerated: row.status === 'deployed' ? 10 : 0,
      deployed: row.status === 'deployed',
      userApproved: row.status === 'deployed',
      userSatisfied: null,
      tripwireHits: 0,
      retries: 0,
      durationSeconds: 0,
      appComplexity: 0.5,
    };
  });

  const knobs = identifyTuningKnobs(calculateVDR(outcomes).vdr, outcomes);
  return c.json({ knobs, currentVdr: calculateVDR(outcomes) });
});

export { vdrRoutes };

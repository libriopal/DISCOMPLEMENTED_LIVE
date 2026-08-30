/**
 * Simulation Ingest — public route (secret-auth, not user-auth).
 * Mounted BEFORE requireAuth so the out-of-band Monte Carlo engine
 * can POST results without a user session.
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';

type Env = {
  DB: D1Database;
  SIMULATION_INGEST_SECRET: string;
};

export const simulationIngestRoutes = new Hono<{ Bindings: Env }>();

simulationIngestRoutes.post('/', async (c) => {
  const secret = c.req.header('X-Simulation-Secret');
  if (!secret || secret !== c.env.SIMULATION_INGEST_SECRET) {
    throw new BicameralError(
      'Invalid simulation ingest secret',
      'UNAUTHORIZED',
      401
    );
  }

  const body = await c.req.json();
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO simulation_runs (
      id, run_type, status, num_bots, total_credits_simulated,
      vdr_percent, house_edge_percent, exploits_found_json,
      tripwire_breakdown_json, recommendations_json, raw_report_json,
      approved_by_admin, applied_to_architecture, created_date, created_by
    ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'), 'monte-carlo-engine')`
  )
    .bind(
      id,
      body.runType ?? 'monte_carlo',
      body.numBots,
      body.totalCreditsSimulated,
      body.vdrPercent ?? null,
      body.houseEdgePercent ?? null,
      JSON.stringify(body.exploitsFound ?? []),
      JSON.stringify(body.tripwireBreakdown ?? {}),
      JSON.stringify(body.recommendations ?? []),
      JSON.stringify(body.rawReport ?? {})
    )
    .run();

  return c.json({
    id,
    status: 'stored',
    message: 'Simulation report stored. Awaiting admin review.',
  });
});

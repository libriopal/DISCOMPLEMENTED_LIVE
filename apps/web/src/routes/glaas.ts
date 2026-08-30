/**
 * GLAAS-Lattice Routes — Governed Lattice Architecture for Agent Separation.
 *
 * The lattice is the execution structure for the agent pipeline:
 * research → audit → design → code → verify
 *
 * Each node is governed by fitness gates. The lattice evolves toward
 * zero-waste value delivery — every credit spent must produce verified value.
 *
 * GET  /api/glaas/topology        — Get the lattice topology (nodes + edges)
 * POST /api/glaas/execute         — Initialize a new lattice execution
 * POST /api/glaas/execute/:id/step — Step the lattice (advance one agent node)
 * GET  /api/glaas/execute/:id     — Get lattice execution state
 *
 * Wired to the evolved genome from Butterfly v7:
 *   pipeline_mode: serial
 *   agent_count: 2
 *   retry_limit: 4
 *   deployment_gate_score: 0.355
 *   tripwire_sensitivity: 4
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';
import {
  initLattice,
  stepLattice,
  getLatticeTopology,
  shouldEarlyExit,
  checkTripwires,
  type LatticeExecution,
} from '@bicameral/shared/glaas/lattice';

type Env = {
  DB: D1Database;
};

const glaasRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; isAdmin: boolean };
}>();

/**
 * GET /api/glaas/topology — Get the lattice topology.
 * Returns the agent lattice structure: nodes, edges, and genome.
 */
glaasRoutes.get('/topology', async (c) => {
  const topology = getLatticeTopology();
  return c.json(topology);
});

/**
 * POST /api/glaas/execute — Initialize a new lattice execution.
 * Creates a fresh lattice with all nodes in 'pending' state.
 */
glaasRoutes.post('/execute', async (c) => {
  const userId = c.get('userId');

  const lattice = initLattice();

  // Persist to D1
  await c.env.DB.prepare(
    `INSERT INTO lattice_executions (id, user_id, status, vdr, zero_waste_score, total_credits, value_credits, nodes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      lattice.id,
      userId,
      lattice.status,
      lattice.vdr,
      lattice.zero_waste_score,
      lattice.total_credits,
      lattice.value_credits,
      JSON.stringify(lattice.nodes),
      lattice.created_at
    )
    .run();

  return c.json(lattice);
});

/**
 * POST /api/glaas/execute/:id/step — Advance one node in the lattice.
 * The caller provides the role to step and its result.
 */
glaasRoutes.post('/execute/:id/step', async (c) => {
  const userId = c.get('userId');
  const executionId = c.req.param('id');

  // Load current lattice from D1
  const row = await c.env.DB.prepare(
    'SELECT * FROM lattice_executions WHERE id = ? AND user_id = ?'
  )
    .bind(executionId, userId)
    .first<{
      id: string;
      status: string;
      vdr: number;
      zero_waste_score: number;
      total_credits: number;
      value_credits: number;
      nodes_json: string;
    }>();

  if (!row) {
    throw new BicameralError('NOT_FOUND', 'Lattice execution not found', 404);
  }

  // Reconstruct lattice
  const lattice: LatticeExecution = {
    id: row.id,
    nodes: JSON.parse(row.nodes_json),
    vdr: row.vdr,
    zero_waste_score: row.zero_waste_score,
    total_credits: row.total_credits,
    value_credits: row.value_credits,
    status: row.status as 'running' | 'completed' | 'failed',
    created_at: new Date().toISOString(),
  };

  const body = await c.req.json<{
    role: 'research' | 'audit' | 'design' | 'code' | 'verify';
    fitness_score: number;
    artifacts: string[];
    credits_spent: number;
    value_produced: number;
  }>();

  // Step the lattice
  const updated = stepLattice(lattice, body.role, {
    fitness_score: body.fitness_score,
    artifacts: body.artifacts,
    credits_spent: body.credits_spent,
    value_produced: body.value_produced,
  });

  // Check tripwires
  const tripwireHits = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM tripwire_events WHERE execution_id = ?'
  )
    .bind(executionId)
    .first<{ count: number }>();

  if (tripwireHits && checkTripwires(tripwireHits.count)) {
    updated.status = 'failed';
  }

  // Check early exit
  if (
    shouldEarlyExit(updated.total_credits, updated.value_credits > 0 ? 1 : 0)
  ) {
    updated.status = 'failed';
  }

  // Persist updated lattice
  await c.env.DB.prepare(
    `UPDATE lattice_executions
     SET status = ?, vdr = ?, zero_waste_score = ?, total_credits = ?, value_credits = ?, nodes_json = ?
     WHERE id = ?`
  )
    .bind(
      updated.status,
      updated.vdr,
      updated.zero_waste_score,
      updated.total_credits,
      updated.value_credits,
      JSON.stringify(updated.nodes),
      executionId
    )
    .run();

  return c.json(updated);
});

/**
 * GET /api/glaas/execute/:id — Get lattice execution state.
 */
glaasRoutes.get('/execute/:id', async (c) => {
  const userId = c.get('userId');
  const executionId = c.req.param('id');

  const row = await c.env.DB.prepare(
    'SELECT * FROM lattice_executions WHERE id = ? AND user_id = ?'
  )
    .bind(executionId, userId)
    .first();

  if (!row) {
    throw new BicameralError('NOT_FOUND', 'Lattice execution not found', 404);
  }

  const result = { ...row, nodes: JSON.parse(row.nodes_json as string) };
  return c.json(result);
});

/**
 * GET /api/glaas/executions — List lattice executions for the current user.
 */
glaasRoutes.get('/executions', async (c) => {
  const userId = c.get('userId');

  const { results } = await c.env.DB.prepare(
    'SELECT id, status, vdr, zero_waste_score, total_credits, value_credits, created_at FROM lattice_executions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  )
    .bind(userId)
    .all();

  return c.json({ executions: results });
});

export { glaasRoutes };

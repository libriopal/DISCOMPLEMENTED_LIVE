/**
 * Memory Lattice — node/edge CRUD. See @agent_docs/api-spec.md "Lattice".
 * Ownership is checked via the parent project's user_id; pipeline-enriched
 * nodes carry `metadata.pipeline_step` / `metadata.agent_role` (written by
 * lattice-enrich.ts in Phase 5b) and pass through untouched here.
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const latticeRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

interface LatticeNodeRow {
  id: string;
  project_id: string;
  type: string;
  label: string;
  embedding_id: string | null;
  metadata: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  created_date: string;
  updated_date: string;
}

interface LatticeEdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  weight: number;
  type: string;
  created_date: string;
}

function serializeNode(row: LatticeNodeRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    label: row.label,
    embeddingId: row.embedding_id,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    position: [row.x ?? 0, row.y ?? 0, row.z ?? 0],
    createdAt: row.created_date,
    updatedAt: row.updated_date,
  };
}

function serializeEdge(row: LatticeEdgeRow) {
  return {
    id: row.id,
    sourceId: row.source_node_id,
    targetId: row.target_node_id,
    weight: row.weight,
    type: row.type,
    createdAt: row.created_date,
  };
}

async function assertProjectOwner(
  db: D1Database,
  projectId: string,
  userId: string
) {
  const project = await db
    .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
    .bind(projectId, userId)
    .first<{ id: string }>();
  if (!project)
    throw new BicameralError('Project not found', 'PROJECT_NOT_FOUND', 404);
}

async function assertNodeOwner(
  db: D1Database,
  nodeId: string,
  userId: string
): Promise<LatticeNodeRow> {
  const node = await db
    .prepare(
      `SELECT n.* FROM lattice_nodes n
       JOIN projects p ON p.id = n.project_id
       WHERE n.id = ? AND p.user_id = ?`
    )
    .bind(nodeId, userId)
    .first<LatticeNodeRow>();
  if (!node)
    throw new BicameralError(
      'Lattice node not found',
      'LATTICE_NODE_NOT_FOUND',
      404
    );
  return node;
}

latticeRoutes.get('/:projectId', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const nodes = await c.env.DB.prepare(
    'SELECT * FROM lattice_nodes WHERE project_id = ? ORDER BY created_date ASC'
  )
    .bind(projectId)
    .all<LatticeNodeRow>();

  const nodeIds = nodes.results.map((n) => n.id);
  let edges: LatticeEdgeRow[] = [];
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => '?').join(',');
    const edgeResult = await c.env.DB.prepare(
      `SELECT * FROM lattice_edges WHERE source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders})`
    )
      .bind(...nodeIds, ...nodeIds)
      .all<LatticeEdgeRow>();
    edges = edgeResult.results;
  }

  return c.json({
    nodes: nodes.results.map(serializeNode),
    edges: edges.map(serializeEdge),
  });
});

latticeRoutes.post('/:projectId/nodes', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const body = await c.req.json<{
    type: string;
    label: string;
    embeddingId?: string;
    metadata?: Record<string, unknown>;
    position?: [number, number, number];
  }>();
  if (!body.type || !body.label) {
    throw new BicameralError(
      'type and label are required',
      'VALIDATION_ERROR',
      400
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const [x, y, z] = body.position ?? [0, 0, 0];

  await c.env.DB.prepare(
    `INSERT INTO lattice_nodes (id, project_id, type, label, embedding_id, metadata, x, y, z, created_date, updated_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      projectId,
      body.type,
      body.label,
      body.embeddingId ?? null,
      body.metadata ? JSON.stringify(body.metadata) : null,
      x,
      y,
      z,
      now,
      now,
      userId
    )
    .run();

  return c.json(
    serializeNode(await assertNodeOwner(c.env.DB, id, userId)),
    201
  );
});

latticeRoutes.patch('/nodes/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await assertNodeOwner(c.env.DB, id, userId);

  const body = await c.req.json<{
    label?: string;
    metadata?: Record<string, unknown>;
    position?: [number, number, number];
  }>();
  const now = new Date().toISOString();
  const [x, y, z] = body.position ?? [null, null, null];

  await c.env.DB.prepare(
    `UPDATE lattice_nodes SET
       label = COALESCE(?, label),
       metadata = COALESCE(?, metadata),
       x = COALESCE(?, x),
       y = COALESCE(?, y),
       z = COALESCE(?, z),
       updated_date = ?
     WHERE id = ?`
  )
    .bind(
      body.label ?? null,
      body.metadata ? JSON.stringify(body.metadata) : null,
      x,
      y,
      z,
      now,
      id
    )
    .run();

  return c.json(serializeNode(await assertNodeOwner(c.env.DB, id, userId)));
});

latticeRoutes.delete('/nodes/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await assertNodeOwner(c.env.DB, id, userId);

  await c.env.DB.prepare(
    'DELETE FROM lattice_edges WHERE source_node_id = ? OR target_node_id = ?'
  )
    .bind(id, id)
    .run();
  await c.env.DB.prepare('DELETE FROM lattice_nodes WHERE id = ?')
    .bind(id)
    .run();

  return c.json({ success: true });
});

latticeRoutes.post('/:projectId/edges', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const body = await c.req.json<{
    sourceId: string;
    targetId: string;
    type?: string;
    weight?: number;
  }>();
  if (!body.sourceId || !body.targetId) {
    throw new BicameralError(
      'sourceId and targetId are required',
      'VALIDATION_ERROR',
      400
    );
  }

  await assertNodeOwner(c.env.DB, body.sourceId, userId);
  await assertNodeOwner(c.env.DB, body.targetId, userId);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO lattice_edges (id, source_node_id, target_node_id, weight, type, created_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.sourceId,
      body.targetId,
      body.weight ?? 1.0,
      body.type ?? 'reference',
      now
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM lattice_edges WHERE id = ?')
    .bind(id)
    .first<LatticeEdgeRow>();
  return c.json(serializeEdge(row as LatticeEdgeRow), 201);
});

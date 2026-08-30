/**
 * Projects — CRUD + file storage. See @agent_docs/api-spec.md "Projects".
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';
import type { ProjectFile } from '@bicameral/shared/types';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const projectsRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: string;
  files: string | null;
  created_date: string;
  updated_date: string;
}

function serializeProject(row: ProjectRow) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_date,
    updatedAt: row.updated_date,
  };
}

async function loadOwnedProject(
  db: D1Database,
  id: string,
  userId: string
): Promise<ProjectRow> {
  const row = await db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<ProjectRow>();
  if (!row)
    throw new BicameralError('Project not found', 'PROJECT_NOT_FOUND', 404);
  return row;
}

projectsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE user_id = ? ORDER BY created_date DESC'
  )
    .bind(userId)
    .all<ProjectRow>();
  return c.json(results.map(serializeProject));
});

projectsRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name) {
    throw new BicameralError('name is required', 'VALIDATION_ERROR', 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, user_id, name, description, status, files, created_date, updated_date, created_by)
     VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?)`
  )
    .bind(id, userId, body.name, body.description ?? null, now, now, userId)
    .run();

  const row = await loadOwnedProject(c.env.DB, id, userId);
  return c.json(serializeProject(row), 201);
});

projectsRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const row = await loadOwnedProject(c.env.DB, c.req.param('id'), userId);

  const pipelineRuns = await c.env.DB.prepare(
    'SELECT id FROM pipeline_runs WHERE project_id = ? ORDER BY created_date DESC'
  )
    .bind(row.id)
    .all<{ id: string }>();

  return c.json({
    ...serializeProject(row),
    pipelineRunIds: pipelineRuns.results.map((r) => r.id),
  });
});

projectsRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await loadOwnedProject(c.env.DB, id, userId);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    status?: string;
  }>();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `UPDATE projects SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       status = COALESCE(?, status),
       updated_date = ?
     WHERE id = ? AND user_id = ?`
  )
    .bind(
      body.name ?? null,
      body.description ?? null,
      body.status ?? null,
      now,
      id,
      userId
    )
    .run();

  const row = await loadOwnedProject(c.env.DB, id, userId);
  return c.json(serializeProject(row));
});

projectsRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await loadOwnedProject(c.env.DB, id, userId);

  await c.env.DB.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run();

  return c.json({ success: true });
});

projectsRoutes.get('/:id/files', async (c) => {
  const userId = c.get('userId');
  const row = await loadOwnedProject(c.env.DB, c.req.param('id'), userId);
  const files: ProjectFile[] = row.files ? JSON.parse(row.files) : [];
  return c.json({ files });
});

projectsRoutes.post('/:id/files', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await loadOwnedProject(c.env.DB, id, userId);

  const body = await c.req.json<{ files: ProjectFile[] }>();
  if (!Array.isArray(body.files)) {
    throw new BicameralError('files must be an array', 'VALIDATION_ERROR', 400);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    'UPDATE projects SET files = ?, updated_date = ? WHERE id = ? AND user_id = ?'
  )
    .bind(JSON.stringify(body.files), now, id, userId)
    .run();

  return c.json({ success: true, fileCount: body.files.length });
});

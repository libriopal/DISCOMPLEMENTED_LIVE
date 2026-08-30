/** Preference Learning — admin observability. Admin-read required. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { requireAdmin } from '../lib/admin-middleware.js';

export const preferencesRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

preferencesRoutes.use('*', requireAdmin('-read'));

preferencesRoutes.get('/matrix/:projectId', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM preference_matrix WHERE project_id = ? ORDER BY feature`
  ).bind(c.req.param('projectId')).all();
  return c.json({ matrix: results });
});

preferencesRoutes.get('/corrections/:projectId', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM preference_corrections WHERE project_id = ? ORDER BY created_date DESC LIMIT 100`
  ).bind(c.req.param('projectId')).all();
  return c.json({ corrections: results });
});

preferencesRoutes.get('/rules/:projectId', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM project_rules WHERE project_id = ? AND active = 1 ORDER BY created_date DESC`
  ).bind(c.req.param('projectId')).all();
  return c.json({ rules: results });
});

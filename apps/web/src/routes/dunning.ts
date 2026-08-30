/** Dunning Workflow — admin observability. Admin-read required. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { requireAdmin } from '../lib/admin-middleware.js';
import { processRetry, recoverWorkflow } from '../lib/decline-recovery.js';

export const dunningRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

dunningRoutes.use('*', requireAdmin('-read'));

dunningRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM dunning_workflow ORDER BY created_date DESC LIMIT 100`
  ).all();
  return c.json({ workflows: results });
});

dunningRoutes.get('/:id', async (c) => {
  const wf = await c.env.DB.prepare('SELECT * FROM dunning_workflow WHERE id = ?')
    .bind(c.req.param('id')).first();
  if (!wf) return c.json({ error: 'Not found' }, 404);
  return c.json({ workflow: wf });
});

dunningRoutes.post('/:id/retry', async (c) => {
  const result = await processRetry(c.env.DB, c.req.param('id'));
  return c.json(result);
});

dunningRoutes.post('/:id/recover', async (c) => {
  await recoverWorkflow(c.env.DB, c.req.param('id'));
  return c.json({ status: 'recovered' });
});

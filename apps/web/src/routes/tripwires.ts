/** Tripwire Events — admin observability. Admin-read required. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { requireAdmin } from '../lib/admin-middleware.js';
import { executeRemedy, getPendingRemedies } from '../lib/tripwires.js';

export const tripwiresRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

tripwiresRoutes.use('*', requireAdmin('-read'));

tripwiresRoutes.get('/', async (c) => {
  const status = c.req.query('status');
  const severity = c.req.query('severity');
  let sql = `SELECT * FROM tripwire_events WHERE 1=1`;
  const binds: string[] = [];
  if (status) { sql += ` AND remedy_status = ?`; binds.push(status); }
  if (severity) { sql += ` AND severity = ?`; binds.push(severity); }
  sql += ` ORDER BY created_date DESC LIMIT 100`;
  const stmt = c.env.DB.prepare(sql);
  const { results } = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();
  return c.json({ events: results });
});

tripwiresRoutes.get('/pending', async (c) => {
  const pending = await getPendingRemedies(c.env.DB);
  return c.json({ events: pending });
});

tripwiresRoutes.get('/:id', async (c) => {
  const event = await c.env.DB.prepare('SELECT * FROM tripwire_events WHERE id = ?')
    .bind(c.req.param('id')).first();
  if (!event) return c.json({ error: 'Not found' }, 404);
  return c.json({ event });
});

tripwiresRoutes.post('/:id/remedy', async (c) => {
  // This requires admin-write
  const adminId = c.get('userId');
  await executeRemedy(c.env.DB, c.req.param('id'));
  return c.json({ status: 'applied' });
});

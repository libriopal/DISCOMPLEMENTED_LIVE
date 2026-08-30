/** Entitlements — admin management. Admin-write required. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { requireAdmin } from '../lib/admin-middleware.js';
import { listEntitlements, setEntitlement } from '../lib/entitlements.js';

export const entitlementsRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

entitlementsRoutes.use('*', requireAdmin('-write'));

entitlementsRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entitlements ORDER BY created_date DESC LIMIT 100`
  ).all();
  return c.json({ entitlements: results });
});

entitlementsRoutes.get('/:userId', async (c) => {
  const ents = await listEntitlements(c.env.DB, c.req.param('userId'));
  return c.json({ entitlements: ents });
});

entitlementsRoutes.post('/', async (c) => {
  const adminId = c.get('userId');
  const { userId, feature, access, reason } = await c.req.json<{
    userId: string; feature: string; access: 'allow' | 'deny' | 'degrade'; reason: string;
  }>();
  await setEntitlement(c.env.DB, userId, feature, access, reason, 'admin', adminId);
  return c.json({ status: 'ok' });
});

entitlementsRoutes.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM entitlements WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ status: 'ok' });
});

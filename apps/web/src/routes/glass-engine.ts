/** Glass Engine — admin observability routes. Admin-only. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { requireAdmin } from '../lib/admin-middleware.js';

export const glassEngineRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// All routes are admin-read minimum
glassEngineRoutes.use('*', requireAdmin('-read'));

glassEngineRoutes.get('/sql-tape', async (c) => {
  const id = c.env.GLASS_ENGINE_DO.idFromName('default');
  const stub = c.env.GLASS_ENGINE_DO.get(id);
  const res = await stub.fetch(new Request('https://internal/sql-tape?limit=100'));
  const data = await res.json();
  return c.json(data);
});

glassEngineRoutes.get('/sql-tape/stream', async (c) => {
  const id = c.env.GLASS_ENGINE_DO.idFromName('default');
  const stub = c.env.GLASS_ENGINE_DO.get(id);
  return stub.fetch(new Request('https://internal/sql-tape/stream', {
    headers: { Upgrade: 'websocket' },
  }));
});

glassEngineRoutes.get('/function-log', async (c) => {
  const id = c.env.GLASS_ENGINE_DO.idFromName('default');
  const stub = c.env.GLASS_ENGINE_DO.get(id);
  const res = await stub.fetch(new Request('https://internal/function-log?limit=100'));
  const data = await res.json();
  return c.json(data);
});

glassEngineRoutes.get('/function-log/stream', async (c) => {
  const id = c.env.GLASS_ENGINE_DO.idFromName('default');
  const stub = c.env.GLASS_ENGINE_DO.get(id);
  return stub.fetch(new Request('https://internal/function-log/stream', {
    headers: { Upgrade: 'websocket' },
  }));
});

glassEngineRoutes.get('/auth-trace', async (c) => {
  const id = c.env.GLASS_ENGINE_DO.idFromName('default');
  const stub = c.env.GLASS_ENGINE_DO.get(id);
  const res = await stub.fetch(new Request('https://internal/auth-trace?limit=100'));
  const data = await res.json();
  return c.json(data);
});

glassEngineRoutes.get('/auth-trace/stream', async (c) => {
  const id = c.env.GLASS_ENGINE_DO.idFromName('default');
  const stub = c.env.GLASS_ENGINE_DO.get(id);
  return stub.fetch(new Request('https://internal/auth-trace/stream', {
    headers: { Upgrade: 'websocket' },
  }));
});

glassEngineRoutes.get('/schema-map', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all<{ name: string; sql: string }>();
  return c.json({ tables: results.map(r => ({ name: r.name, sql: r.sql })) });
});

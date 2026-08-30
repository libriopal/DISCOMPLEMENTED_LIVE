/** Value Panel — user-facing value transparency. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const valueRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

valueRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare(
    'SELECT tier, credits_remaining, credits_used FROM users WHERE id = ?'
  ).bind(userId).first<{ tier: string; credits_remaining: number; credits_used: number }>();

  const costResult = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(credits), 0) as total_cost FROM cost_events WHERE user_id = ?`
  ).bind(userId).first<{ total_cost: number }>();

  const genResult = await c.env.DB.prepare(
    `SELECT
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as success_count,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as fail_count,
      COUNT(*) as total
    FROM pipeline_runs WHERE user_id = ?`
  ).bind(userId).first<{ success_count: number; fail_count: number; total: number }>();

  const activeProjects = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM projects WHERE user_id = ? AND status = ?'
  ).bind(userId, 'active').first<{ count: number }>();

  const successCount = genResult?.success_count ?? 0;
  const totalGen = genResult?.total ?? 0;
  const deliveryRate = totalGen > 0 ? successCount / totalGen : 0;
  const totalCost = costResult?.total_cost ?? 0;
  const valueScore = totalCost > 0 ? Math.min(deliveryRate, successCount / Math.max(1, totalCost / 1000)) : 0;

  return c.json({
    creditsUsed: user?.credits_used ?? 0,
    creditsRemaining: user?.credits_remaining ?? 0,
    totalCost,
    deliveryRate,
    burnRate: 0,
    valueScore,
    activeProjects: activeProjects?.count ?? 0,
    failedGenerations: genResult?.fail_count ?? 0,
  });
});

valueRoutes.get('/history', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM cost_events WHERE user_id = ? ORDER BY created_date DESC LIMIT 100`
  ).bind(userId).all();
  return c.json({ history: results });
});

valueRoutes.get('/delivery', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT status, COUNT(*) as count, AVG(strftime('%s', completed_at) - strftime('%s', created_date)) as avg_duration
     FROM pipeline_runs WHERE user_id = ?
     GROUP BY status`
  ).bind(userId).all();
  return c.json({ delivery: results });
});

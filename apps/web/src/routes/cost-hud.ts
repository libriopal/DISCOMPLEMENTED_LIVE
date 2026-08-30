/** Cost HUD — cost breakdown by feature and agent step. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const costHudRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

costHudRoutes.get('/summary', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT feature, agent_step, SUM(credits) as credits
     FROM cost_events WHERE user_id = ?
     GROUP BY feature, agent_step ORDER BY credits DESC`
  ).bind(userId).all<{ feature: string; agent_step: string | null; credits: number }>();

  const total = results.reduce((sum, r) => sum + r.credits, 0);
  const breakdown = results.map(r => ({
    ...r,
    percentage: total > 0 ? Math.round((r.credits / total) * 100) : 0,
  }));

  return c.json({ total, breakdown });
});

costHudRoutes.get('/breakdown', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT feature, agent_step, credits, burn_rate, budget_remaining, created_date
     FROM cost_events WHERE user_id = ? ORDER BY created_date DESC LIMIT 200`
  ).bind(userId).all();
  return c.json({ events: results });
});

costHudRoutes.get('/burn-rate', async (c) => {
  const userId = c.get('userId');
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const result = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(credits), 0) as hourly_burn FROM cost_events WHERE user_id = ? AND created_date >= ?`
  ).bind(userId, oneHourAgo).first<{ hourly_burn: number }>();

  const user = await c.env.DB.prepare(
    'SELECT credits_remaining FROM users WHERE id = ?'
  ).bind(userId).first<{ credits_remaining: number }>();

  return c.json({
    burnRate: result?.hourly_burn ?? 0,
    budgetRemaining: user?.credits_remaining ?? 0,
  });
});

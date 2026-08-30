/**
 * Usage Routes — credit balance, usage breakdown, and velocity forecasting.
 *
 * GET /              — Usage summary (credits remaining, used, tier, rate limit)
 * GET /credits       — Credit balance + recent ledger history
 * GET /breakdown     — Usage breakdown by model and pipeline step
 * GET /forecast      — Credit velocity forecast (trailing 7-day burn rate + depletion date)
 *
 * The forecast endpoint powers the real-time credit burndown widget in the
 * sidebar and proactive low-balance alerts (NS1: catch value gaps before
 * the user notices).
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { issueVirtualKeyIfMissing, sha256Hex } from '../lib/virtual-key.js';

export const usageRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

// GET / — Usage summary
usageRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare(
    'SELECT credits_remaining, credits_used, tier, virtual_key FROM users WHERE id = ?'
  ).bind(userId).first<{ credits_remaining: number; credits_used: number; tier: string; virtual_key: string | null }>();

  if (!user) return c.json({ error: 'User not found' }, 404);

  // Get current rate limit window
  const windowStart = new Date(
    Math.floor(Date.now() / 3_600_000) * 3_600_000
  ).toISOString();

  const rateLimit = await c.env.DB.prepare(
    'SELECT request_count FROM rate_limit_windows WHERE virtual_key = (SELECT virtual_key FROM users WHERE id = ?) AND window_start = ?'
  ).bind(userId, windowStart).first<{ request_count: number }>();

  return c.json({
    hasApiKey: user.virtual_key !== null,
    creditsRemaining: user.credits_remaining,
    creditsUsed: user.credits_used,
    tier: user.tier,
    rateLimitRemaining: Math.max(0, 100 - (rateLimit?.request_count ?? 0)),
  });
});

// POST /regenerate-key — Generate or regenerate the user's virtual API key
// Returns the raw key once. The key is stored as a SHA-256 hash in the database
// and cannot be recovered. If the user already has a key, it is invalidated.
usageRoutes.post('/regenerate-key', async (c) => {
  const userId = c.get('userId');
  const rawKey = crypto.randomUUID();
  const hashed = await sha256Hex(rawKey);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    'UPDATE users SET virtual_key = ?, updated_date = ? WHERE id = ?'
  ).bind(hashed, now, userId).run();

  return c.json({ apiKey: rawKey, message: 'Store this key securely — it cannot be recovered.' });
});

// GET /credits — Credit balance + history
usageRoutes.get('/credits', async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare(
    'SELECT credits_remaining, credits_used FROM users WHERE id = ?'
  ).bind(userId).first<{ credits_remaining: number; credits_used: number }>();

  if (!user) return c.json({ error: 'User not found' }, 404);

  const history = await c.env.DB.prepare(
    'SELECT amount, type, description, created_date as date FROM credit_ledger WHERE user_id = ? ORDER BY created_date DESC LIMIT 20'
  ).bind(userId).all();

  return c.json({
    balance: user.credits_remaining,
    used: user.credits_used,
    history: history.results ?? [],
  });
});

// GET /breakdown — Usage by model and pipeline step
usageRoutes.get('/breakdown', async (c) => {
  const userId = c.get('userId');
  const steps = await c.env.DB.prepare(
    `SELECT agent_role, model_used, SUM(credits_used) as total_credits, COUNT(*) as count
     FROM pipeline_steps
     WHERE created_by = ?
     GROUP BY agent_role, model_used
     ORDER BY total_credits DESC`
  ).bind(userId).all();

  const byModel: Record<string, { count: number; tokens: number }> = {};
  const byPipelineStep: Record<string, { count: number; tokens: number }> = {};

  for (const step of steps.results ?? []) {
    const s = step as Record<string, unknown>;
    const model = (s.model_used as string) || 'unknown';
    const role = (s.agent_role as string) || 'unknown';
    const credits = (s.total_credits as number) || 0;
    const count = (s.count as number) || 0;

    if (!byModel[model]) byModel[model] = { count: 0, tokens: 0 };
    byModel[model].count += count;
    byModel[model].tokens += credits;

    if (!byPipelineStep[role]) byPipelineStep[role] = { count: 0, tokens: 0 };
    byPipelineStep[role].count += count;
    byPipelineStep[role].tokens += credits;
  }

  return c.json({ byModel, byPipelineStep });
});

// GET /forecast — Credit velocity forecast (trailing 7-day burn rate + depletion date)
// Powers the real-time credit burndown widget and proactive low-balance alerts.
usageRoutes.get('/forecast', async (c) => {
  const userId = c.get('userId');
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get user's current balance
  const user = await c.env.DB.prepare(
    'SELECT credits_remaining, credits_used, tier, virtual_key FROM users WHERE id = ?'
  ).bind(userId).first<{ credits_remaining: number; credits_used: number; tier: string; virtual_key: string | null }>();

  if (!user) return c.json({ error: 'User not found' }, 404);

  // Get trailing 7-day debit history from credit_ledger
  const debits = await c.env.DB.prepare(
    `SELECT amount, type, created_date FROM credit_ledger
     WHERE user_id = ? AND type = 'debit' AND created_date >= ?
     ORDER BY created_date ASC`
  ).bind(userId, sevenDaysAgo).all();

  const debitResults = debits.results ?? [];

  // Calculate daily burn rate
  const dailyTotals: Record<string, number> = {};
  for (const entry of debitResults) {
    const e = entry as Record<string, unknown>;
    const date = (e.created_date as string)?.split('T')[0] ?? 'unknown';
    const amount = Math.abs(e.amount as number) || 0;
    dailyTotals[date] = (dailyTotals[date] ?? 0) + amount;
  }

  const dailyAmounts = Object.values(dailyTotals);
  const activeDays = dailyAmounts.length;
  const totalBurn = dailyAmounts.reduce((a, b) => a + b, 0);
  const avgDailyBurn = activeDays > 0 ? totalBurn / 7 : 0; // Average over 7 days, not just active days

  // Calculate velocity trend (last 3 days vs first 4 days)
  const recentDays = dailyAmounts.slice(-3);
  const earlyDays = dailyAmounts.slice(0, Math.max(0, activeDays - 3));
  const recentAvg = recentDays.length > 0 ? recentDays.reduce((a, b) => a + b, 0) / recentDays.length : 0;
  const earlyAvg = earlyDays.length > 0 ? earlyDays.reduce((a, b) => a + b, 0) / earlyDays.length : 0;
  const trend = recentAvg > earlyAvg * 1.2 ? 'accelerating' : recentAvg < earlyAvg * 0.8 ? 'decelerating' : 'stable';

  // Predict depletion date
  let daysUntilDepletion: number | null = null;
  let projectedDepletionDate: string | null = null;
  if (avgDailyBurn > 0) {
    daysUntilDepletion = Math.floor(user.credits_remaining / avgDailyBurn);
    if (daysUntilDepletion > 0 && daysUntilDepletion < 365) {
      projectedDepletionDate = new Date(now.getTime() + daysUntilDepletion * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  // Determine alert level
  const balancePercent = user.credits_remaining > 0 ? 100 : 0;
  let alertLevel: 'none' | 'warning' | 'urgent' = 'none';
  if (user.credits_remaining <= 10) alertLevel = 'urgent';
  else if (user.credits_remaining <= 50 || (daysUntilDepletion !== null && daysUntilDepletion <= 3)) alertLevel = 'warning';

  return c.json({
    balance: user.credits_remaining,
    used: user.credits_used,
    tier: user.tier,
    burnRate: {
      avgDailyBurn: Math.round(avgDailyBurn * 100) / 100,
      total7Day: totalBurn,
      activeDays,
      trend, // 'accelerating' | 'decelerating' | 'stable'
    },
    forecast: {
      daysUntilDepletion,
      projectedDepletionDate,
      isLowBalance: alertLevel !== 'none',
      alertLevel, // 'none' | 'warning' | 'urgent'
      balancePercent,
    },
    dailyBreakdown: dailyTotals,
  });
});

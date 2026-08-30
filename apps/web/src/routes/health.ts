/**
 * Health Monitoring Routes — Proactive gap detection and churn prediction.
 *
 * This is the POETIC EQUATION engine: the system that detects value gaps
 * BEFORE the user notices and closes them autonomously.
 *
 * GET  /api/health/:userId        — Current health score for a user
 * GET  /api/health/:userId/trend  — Health score history (last 30 days)
 * POST /api/health/:userId/score  — Calculate fresh health score (admin)
 * POST /api/health/:userId/churn  — Predict churn risk (admin)
 * POST /api/health/gap-detect     — Detect and close a value gap (admin)
 *
 * Wired to the evolved genome's proactive detection genes:
 *   health_score_enabled: true
 *   churn_prediction_model: hybrid (heuristic + ML trend analysis)
 *   sentiment_analysis_source: real-time (from chat + UI signals)
 *   auto_intervention: auto-credit
 *   early_warning_threshold: 0.3
 */
import { Hono } from 'hono';
import { requireAdmin } from '../lib/admin-middleware.js';
import type { AuthVariables } from '../lib/require-auth.js';
import type { Env } from '../env.js';
import { BicameralError } from '@bicameral/shared/errors';
import {
  calculateHealthScore,
  predictChurnHybrid,
  detectAndCloseGap,
  analyzeRealTimeSentiment,
} from '@bicameral/shared/glaas/proactive-detection';

const healthRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

/**
 * GET /api/health/:userId — Get current health score from D1.
 */
healthRoutes.get('/:userId', async (c) => {
  const authedUserId = c.get('userId');
  const targetUserId = c.req.param('userId');
  // Users can only access their own health score; admin check via route is optional
  if (authedUserId !== targetUserId) {
    const user = await c.env.DB.prepare(
      'SELECT admin_level FROM users WHERE id = ?'
    )
      .bind(authedUserId)
      .first();
    if (!user?.admin_level) {
      return c.json(
        { error: 'Access denied — you can only view your own health score' },
        403
      );
    }
  }
  const score = await c.env.DB.prepare(
    'SELECT * FROM health_scores WHERE user_id = ? ORDER BY last_updated DESC LIMIT 1'
  )
    .bind(targetUserId)
    .first();

  if (!score) {
    return c.json({
      user_id: targetUserId,
      overall_score: null,
      risk_level: 'unknown',
      detected_issues: [],
      recommended_actions: [],
      last_updated: null,
      message: 'No health score calculated yet',
    });
  }

  return c.json(score);
});

/**
 * GET /api/health/:userId/trend — Health score history.
 */
healthRoutes.get('/:userId/trend', async (c) => {
  const targetUserId = c.req.param('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT overall_score, risk_level, detected_issues, last_updated
     FROM health_scores
     WHERE user_id = ?
     ORDER BY last_updated DESC
     LIMIT 30`
  )
    .bind(targetUserId)
    .all();

  return c.json({ user_id: targetUserId, trend: results });
});

/**
 * POST /api/health/:userId/score — Calculate a fresh health score.
 * Admin only. Pulls real metrics from D1 and runs the health engine.
 */
healthRoutes.post('/:userId/score', requireAdmin('-write'), async (c) => {
  const targetUserId = c.req.param('userId');

  // Pull real engagement metrics from D1
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();
  const sixtyDaysAgo = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000
  ).toISOString();

  // Login frequency: count pipeline_runs in last 30d vs previous 30d
  const recentActivity = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM pipeline_runs WHERE user_id = ? AND created_date >= ?`
  )
    .bind(targetUserId, thirtyDaysAgo)
    .first<{ count: number }>();

  const baselineActivity = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM pipeline_runs WHERE user_id = ? AND created_date >= ? AND created_date < ?`
  )
    .bind(targetUserId, sixtyDaysAgo, thirtyDaysAgo)
    .first<{ count: number }>();

  // Feature usage: count completed generations
  const recentCompleted = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM pipeline_runs WHERE user_id = ? AND status = 'completed' AND created_date >= ?`
  )
    .bind(targetUserId, thirtyDaysAgo)
    .first<{ count: number }>();

  const baselineCompleted = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM pipeline_runs WHERE user_id = ? AND status = 'completed' AND created_date >= ? AND created_date < ?`
  )
    .bind(targetUserId, sixtyDaysAgo, thirtyDaysAgo)
    .first<{ count: number }>();

  // Failed payments
  const failedPayments = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM cost_events WHERE user_id = ? AND event_type = 'payment_failed' AND created_date >= ?`
  )
    .bind(targetUserId, thirtyDaysAgo)
    .first<{ count: number }>();

  // VDR for this user
  const vdrResult = await c.env.DB.prepare(
    `SELECT
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as wins,
      COUNT(*) as total
    FROM pipeline_runs WHERE user_id = ?`
  )
    .bind(targetUserId)
    .first<{ wins: number; total: number }>();

  const vdr =
    vdrResult && vdrResult.total > 0
      ? (vdrResult.wins / vdrResult.total) * 100
      : 0;

  // Sentiment: check for negative support interactions
  const sentimentResult = await c.env.DB.prepare(
    `SELECT AVG(CASE WHEN sentiment_score IS NOT NULL THEN sentiment_score ELSE 0.5 END) as avg_sentiment
     FROM chat_messages WHERE user_id = ? AND created_date >= ?`
  )
    .bind(targetUserId, thirtyDaysAgo)
    .first<{ avg_sentiment: number }>();

  const supportSentiment = sentimentResult?.avg_sentiment ?? 0.5;

  // Calculate health score
  const health = calculateHealthScore({
    login_frequency_30d: recentActivity?.count ?? 0,
    login_frequency_baseline: baselineActivity?.count ?? 1,
    core_feature_usage_30d: recentCompleted?.count ?? 0,
    core_feature_usage_baseline: baselineCompleted?.count ?? 1,
    support_sentiment_score: supportSentiment,
    failed_payments_30d: failedPayments?.count ?? 0,
    vdr,
  });

  health.user_id = targetUserId;

  // Upsert into D1 (unique user_id constraint)
  await c.env.DB.prepare(
    `INSERT INTO health_scores (id, user_id, overall_score, engagement_score, feature_adoption_score,
     support_sentiment_score, payment_health_score, vdr_score, risk_level, detected_issues,
     recommended_actions, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       overall_score = ?, engagement_score = ?, feature_adoption_score = ?,
       support_sentiment_score = ?, payment_health_score = ?, vdr_score = ?,
       risk_level = ?, detected_issues = ?, recommended_actions = ?, last_updated = ?`
  )
    .bind(
      crypto.randomUUID(),
      targetUserId,
      health.overall_score,
      health.engagement_score,
      health.feature_adoption_score,
      health.support_sentiment_score,
      health.payment_health_score,
      health.vdr_score,
      health.risk_level,
      JSON.stringify(health.detected_issues),
      JSON.stringify(health.recommended_actions),
      health.last_updated,
      // ON CONFLICT updates
      health.overall_score,
      health.engagement_score,
      health.feature_adoption_score,
      health.support_sentiment_score,
      health.payment_health_score,
      health.vdr_score,
      health.risk_level,
      JSON.stringify(health.detected_issues),
      JSON.stringify(health.recommended_actions),
      health.last_updated
    )
    .run();

  return c.json(health);
});

/**
 * POST /api/health/:userId/churn — Predict churn risk.
 * Admin only. Uses hybrid model: heuristic rules + ML trend analysis.
 */
healthRoutes.post('/:userId/churn', requireAdmin('-write'), async (c) => {
  const targetUserId = c.req.param('userId');

  // Get current health score
  const healthRow = await c.env.DB.prepare(
    'SELECT * FROM health_scores WHERE user_id = ? ORDER BY last_updated DESC LIMIT 1'
  )
    .bind(targetUserId)
    .first();

  if (!healthRow) {
    throw new BicameralError(
      'NOT_FOUND',
      'No health score found — calculate score first',
      404
    );
  }

  // Get sentiment trend (last 5 scores)
  const sentimentTrendResult = await c.env.DB.prepare(
    `SELECT support_sentiment_score FROM health_scores
     WHERE user_id = ? ORDER BY last_updated DESC LIMIT 5`
  )
    .bind(targetUserId)
    .all();
  const sentimentTrend = (sentimentTrendResult.results || []).map(
    (r) => r.support_sentiment_score as number
  );

  // Get VDR trend (last 5 runs)
  const vdrTrendResult = await c.env.DB.prepare(
    `SELECT vdr_score FROM health_scores
     WHERE user_id = ? ORDER BY last_updated DESC LIMIT 5`
  )
    .bind(targetUserId)
    .all();
  const vdrTrend = (vdrTrendResult.results || []).map(
    (r) => (r.vdr_score as number) * 100
  );

  // Days since last login
  const lastActivityResult = await c.env.DB.prepare(
    `SELECT created_date FROM pipeline_runs WHERE user_id = ? ORDER BY created_date DESC LIMIT 1`
  )
    .bind(targetUserId)
    .first<{ created_date: string }>();

  const daysSinceLastLogin = lastActivityResult
    ? Math.floor(
        (Date.now() - new Date(lastActivityResult.created_date).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    : 999;

  // Credit balance
  const userRow = await c.env.DB.prepare(
    'SELECT credits_remaining FROM users WHERE id = ?'
  )
    .bind(targetUserId)
    .first<{ credits_remaining: number }>();

  // Subscription age
  const subRow = await c.env.DB.prepare(
    `SELECT created_date FROM subscriptions WHERE user_id = ? ORDER BY created_date ASC LIMIT 1`
  )
    .bind(targetUserId)
    .first<{ created_date: string }>();

  const subscriptionAgeDays = subRow
    ? Math.floor(
        (Date.now() - new Date(subRow.created_date).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    : 0;

  const health = {
    user_id: targetUserId,
    risk_level: healthRow.risk_level as 'healthy' | 'at-risk' | 'critical',
  } as any;

  const prediction = predictChurnHybrid({
    health_score: health,
    sentiment_trend: sentimentTrend.length > 0 ? sentimentTrend : [0.5],
    vdr_trend: vdrTrend.length > 0 ? vdrTrend : [50],
    days_since_last_login: daysSinceLastLogin,
    credit_balance: userRow?.credits_remaining ?? 0,
    subscription_age_days: subscriptionAgeDays,
  });

  return c.json(prediction);
});

/**
 * POST /api/health/gap-detect — Detect and auto-close a value gap.
 * Admin only. The poetic equation test: can the system detect and fix
 * a value gap before the user notices?
 */
healthRoutes.post('/gap-detect', requireAdmin('-write'), async (c) => {
  // Admin check via requireAdmin middleware

  const body = await c.req.json<{
    userId: string;
    userReportedIssue?: boolean;
  }>();

  const targetUserId = body.userId;

  // Get current VDR for this user
  const vdrResult = await c.env.DB.prepare(
    `SELECT
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as wins,
      COUNT(*) as total
    FROM pipeline_runs WHERE user_id = ?`
  )
    .bind(targetUserId)
    .first<{ wins: number; total: number }>();

  const vdrCurrent =
    vdrResult && vdrResult.total > 0
      ? (vdrResult.wins / vdrResult.total) * 100
      : 0;

  // Get baseline VDR (overall platform average or user's historical average)
  const baselineResult = await c.env.DB.prepare(
    `SELECT
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as wins,
      COUNT(*) as total
    FROM pipeline_runs`
  ).first<{ wins: number; total: number }>();

  const vdrBaseline =
    baselineResult && baselineResult.total > 0
      ? (baselineResult.wins / baselineResult.total) * 100
      : 67.7; // fallback to simulated baseline

  // Get sentiment
  const sentimentResult = await c.env.DB.prepare(
    `SELECT support_sentiment_score FROM health_scores WHERE user_id = ? ORDER BY last_updated DESC LIMIT 1`
  )
    .bind(targetUserId)
    .first<{ support_sentiment_score: number }>();

  const sentimentCurrent = sentimentResult?.support_sentiment_score ?? 0.5;

  // Get error rate
  const errorResult = await c.env.DB.prepare(
    `SELECT
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as errors,
      COUNT(*) as total
    FROM pipeline_runs WHERE user_id = ? AND created_date >= ?`
  )
    .bind(
      targetUserId,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    )
    .first<{ errors: number; total: number }>();

  const errorRateCurrent =
    errorResult && errorResult.total > 0
      ? errorResult.errors / errorResult.total
      : 0;

  // Credit balance
  const userRow = await c.env.DB.prepare(
    'SELECT credits_remaining FROM users WHERE id = ?'
  )
    .bind(targetUserId)
    .first<{ credits_remaining: number }>();

  const gap = detectAndCloseGap({
    vdr_current: vdrCurrent,
    vdr_baseline: vdrBaseline,
    sentiment_current: sentimentCurrent,
    sentiment_baseline: 0.5,
    error_rate_current: errorRateCurrent,
    error_rate_baseline: 0.1,
    credit_balance: userRow?.credits_remaining ?? 0,
    user_reported_issue: body.userReportedIssue ?? false,
  });

  // If auto-resolved and critical, inject credits per EICCA
  if (gap.auto_resolved && gap.gap_type === 'credit_exhaustion') {
    await c.env.DB.prepare(
      // `reason` is not a column on credit_ledger (001_init.sql) — this insert
      // failed at runtime. The free-text column is `description`, and `type`
      // is NOT NULL, so both have to be supplied. Matches how lib/eicca.ts and
      // lib/tripwires.ts write their auto-credit rows.
      `INSERT INTO credit_ledger (id, user_id, amount, type, description, created_date)
       VALUES (?, ?, 50, 'credit', 'EICCA auto-credit injection — gap detected and closed', ?)`
    )
      .bind(crypto.randomUUID(), targetUserId, new Date().toISOString())
      .run();

    await c.env.DB.prepare(
      'UPDATE users SET credits_remaining = credits_remaining + 50 WHERE id = ?'
    )
      .bind(targetUserId)
      .run();

    gap.resolution_action = 'auto-credit-injection: 50 credits injected';
  }

  return c.json(gap);
});

/**
 * POST /api/health/:userId/sentiment — Analyze real-time sentiment from interaction.
 */
healthRoutes.post('/:userId/sentiment', async (c) => {
  const targetUserId = c.req.param('userId');
  const body = await c.req.json<{
    messageLength: number;
    containsNegativeWords: boolean;
    containsPositiveWords: boolean;
    responseTimeMs: number;
    errorCountSession: number;
    repeatedRequests: number;
    sessionDurationMin: number;
  }>();

  const signal = analyzeRealTimeSentiment({
    user_id: targetUserId,
    message_length: body.messageLength ?? 0,
    contains_negative_words: body.containsNegativeWords ?? false,
    contains_positive_words: body.containsPositiveWords ?? false,
    response_time_ms: body.responseTimeMs ?? 1000,
    error_count_session: body.errorCountSession ?? 0,
    repeated_requests: body.repeatedRequests ?? 0,
    session_duration_min: body.sessionDurationMin ?? 0,
  });

  return c.json(signal);
});

export { healthRoutes };

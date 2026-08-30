/**
 * User Behavior Analytics — tracks user interactions to detect value gaps
 * and trigger autonomous recovery (NS1: know when a user isn't getting value
 * before they tell you).
 *
 * POST /api/user-events          — Record a user event
 * GET  /api/user-events          — List user events (for the user themselves)
 * GET  /api/user-events/gaps     — Detect behavioral gaps (user stuck, not getting value)
 *
 * Tracked events: page_view, prompt_submit, pipeline_approve, pipeline_cancel,
 * billing_view, credit_purchase, chat_open, file_download, project_create
 *
 * Gap detection: If a user starts a pipeline but doesn't approve within 10 min,
 * or if they view billing but don't purchase with low credits, or if they
 * haven't had a successful generation in their session, flag it.
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const userEventsRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

const VALID_EVENTS = [
  'page_view',
  'prompt_submit',
  'pipeline_approve',
  'pipeline_cancel',
  'billing_view',
  'credit_purchase',
  'chat_open',
  'file_download',
  'project_create',
  'onboarding_start',
  'onboarding_complete',
  'generation_success',
  'generation_failure',
] as const;

// POST / — Record a user event
userEventsRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    event: string;
    metadata?: Record<string, unknown>;
  }>();

  if (
    !body.event ||
    !VALID_EVENTS.includes(body.event as (typeof VALID_EVENTS)[number])
  ) {
    return c.json({ error: 'Invalid event type' }, 400);
  }

  const now = new Date().toISOString();
  const sessionId = c.req.header('x-session-id') || crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO user_events (id, user_id, session_id, event_type, metadata, created_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      userId,
      sessionId,
      body.event,
      JSON.stringify(body.metadata ?? {}),
      now
    )
    .run();

  return c.json({ recorded: true });
});

// GET / — List user events for the current session
userEventsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') || '50');

  const events = await c.env.DB.prepare(
    `SELECT id, event_type, metadata, created_date FROM user_events
     WHERE user_id = ? ORDER BY created_date DESC LIMIT ?`
  )
    .bind(userId, limit)
    .all();

  return c.json({ events: events.results ?? [] });
});

// GET /gaps — Detect behavioral gaps (NS1: catch value gaps before user notices)
userEventsRoutes.get('/gaps', async (c) => {
  const userId = c.get('userId');
  const now = new Date();
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  // Get recent events
  const events = await c.env.DB.prepare(
    `SELECT event_type, metadata, created_date FROM user_events
     WHERE user_id = ? AND created_date >= ?
     ORDER BY created_date ASC`
  )
    .bind(userId, thirtyMinAgo)
    .all();

  const eventList = events.results ?? [];
  const gaps: Array<{
    type: string;
    severity: 'low' | 'medium' | 'high';
    message: string;
    recommendation: string;
  }> = [];

  // Gap 1: User submitted a prompt but didn't approve the pipeline within 10 min
  const promptSubmitted = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'prompt_submit'
  );
  const pipelineApproved = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'pipeline_approve'
  );
  if (promptSubmitted && !pipelineApproved) {
    const submitTime = new Date(
      (promptSubmitted as Record<string, string>).created_date
    ).getTime();
    const elapsed = Date.now() - submitTime;
    if (elapsed > 10 * 60 * 1000) {
      gaps.push({
        type: 'pipeline_approval_gap',
        severity: 'high',
        message:
          "You submitted a prompt but haven't approved the pipeline blueprint yet.",
        recommendation:
          'Check the blueprint — if it looks right, approve it to continue generation.',
      });
    }
  }

  // Gap 2: User viewed billing but has low credits and didn't purchase
  const billingViewed = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'billing_view'
  );
  const creditPurchased = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'credit_purchase'
  );
  if (billingViewed && !creditPurchased) {
    const user = await c.env.DB.prepare(
      'SELECT credits_remaining FROM users WHERE id = ?'
    )
      .bind(userId)
      .first<{ credits_remaining: number }>();
    if (user && user.credits_remaining < 50) {
      gaps.push({
        type: 'low_credits_no_purchase',
        severity: 'medium',
        message: `You have ${user.credits_remaining} credits remaining — that's low.`,
        recommendation:
          'Consider purchasing a credit pack to avoid interruptions.',
      });
    }
  }

  // Gap 3: User had a generation failure and hasn't retried
  const genFailure = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'generation_failure'
  );
  const genSuccess = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'generation_success'
  );
  if (genFailure && !genSuccess) {
    gaps.push({
      type: 'unresolved_generation_failure',
      severity: 'high',
      message: 'Your last generation attempt failed.',
      recommendation:
        'Try rephrasing your prompt or simplifying your request. Credits have been auto-refunded.',
    });
  }

  // Gap 4: User started onboarding but didn't complete it
  const onboardingStarted = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'onboarding_start'
  );
  const onboardingCompleted = eventList.find(
    (e) => (e as Record<string, string>).event_type === 'onboarding_complete'
  );
  if (onboardingStarted && !onboardingCompleted) {
    gaps.push({
      type: 'incomplete_onboarding',
      severity: 'low',
      message: "You started the onboarding but didn't finish it.",
      recommendation:
        'Complete the quick tour to get the most out of Discomplement.',
    });
  }

  // Gap 5: User has been active for >20 min without a successful generation
  if (eventList.length > 5) {
    const firstEvent = new Date(
      (eventList[0] as Record<string, string>).created_date
    ).getTime();
    const sessionDuration = Date.now() - firstEvent;
    if (sessionDuration > 20 * 60 * 1000 && !genSuccess) {
      gaps.push({
        type: 'no_value_delivered_session',
        severity: 'medium',
        message:
          "You've been active for a while but haven't completed a generation yet.",
        recommendation:
          'Try a simple prompt like "Build a todo app" to see Discomplement in action.',
      });
    }
  }

  return c.json({
    gaps,
    totalGaps: gaps.length,
    hasCriticalGap: gaps.some((g) => g.severity === 'high'),
  });
});

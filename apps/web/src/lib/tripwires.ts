/**
 * Tripwire Engine — evaluates conditions and fires events with dedup
 * and idempotent remedy execution. See PHASE-0-PREFLIGHT.md §tripwires.
 */
import type { Env } from '../env.js';

export interface TripwireEvent {
  id: string;
  tripwire: string;
  user_id: string | null;
  pipeline_run_id: string | null;
  severity: 'info' | 'warning' | 'critical';
  condition_detail: string;
  condition_hash: string;
  remedy:
    | 'pause'
    | 'refund'
    | 'alert'
    | 'block'
    | 'notify'
    | 'auto_grant'
    | 'escalate';
  remedy_status: 'pending' | 'applied' | 'failed' | 'skipped';
  remedy_idempotency_key: string | null;
  retry_attempt: number;
  actor_type: string;
  created_date: string;
  resolved_date: string | null;
}

export interface TripwireMetrics {
  creditsUsed: number;
  creditsRemaining: number;
  burnRate: number;
  failedGenerations: number;
  totalGenerations: number;
  avgDuration: number;
  errorRate: number;
  lastActiveDate: string | null;
}

const MAX_RETRIES = 3;

// Simulation-evolved tripwire thresholds (Butterfly v7, 10.24M interactions)
// These values were proven optimal by Monte Carlo evolutionary simulation.
const TRIPWIRE_THRESHOLDS = {
  empty_generation_streak: 3, // tw_01: consecutive empty generations before pause
  infinite_loop_detection: 4, // tw_02: max loop iterations before abort
  credit_burn_warning: 39, // tw_03: credits burned without delivery before warning
  approval_bypass_attempts: 2, // tw_04: max approval bypass attempts before block
  token_overflow_limit: 89435, // tw_06: max tokens per interaction
  duplicate_generation_limit: 4, // tw_07: max duplicate generations before flag
  timeout_seconds: 91, // tw_08: pipeline timeout in seconds
  unauthorized_attempt_limit: 2, // tw_09: max unauthorized attempts before block
  burn_rate_per_min: 27, // simulation-evolved: max credits/min before warning
} as const;

const TRIPWIRE_CONFIG: Record<
  string,
  {
    severity: TripwireEvent['severity'];
    remedy: TripwireEvent['remedy'];
    description: string;
  }
> = {
  spend_without_delivery: {
    severity: 'critical',
    remedy: 'pause',
    description: 'Credits spent without successful generation',
  },
  burn_rate_exceeded: {
    severity: 'warning',
    remedy: 'alert',
    description: 'Burn rate exceeds threshold',
  },
  credit_depletion: {
    severity: 'critical',
    remedy: 'block',
    description: 'Credits below safe threshold',
  },
  failed_generation_streak: {
    severity: 'warning',
    remedy: 'refund',
    description: '3+ consecutive failed generations',
  },
  refund_cascade: {
    severity: 'critical',
    remedy: 'alert',
    description: 'Multiple refunds in short window',
  },
  revenue_underperformance: {
    severity: 'info',
    remedy: 'notify',
    description: 'Revenue below expected for tier',
  },
  api_error_spike: {
    severity: 'warning',
    remedy: 'alert',
    description: 'Error rate spike detected',
  },
  latency_degradation: {
    severity: 'warning',
    remedy: 'alert',
    description: 'Response time degraded',
  },
  quality_regression: {
    severity: 'warning',
    remedy: 'notify',
    description: 'Output quality score dropped',
  },
  cost_anomaly: {
    severity: 'critical',
    remedy: 'escalate',
    description: 'Unusual cost pattern detected',
  },
  abandonment_risk: {
    severity: 'info',
    remedy: 'auto_grant',
    description: 'User showing churn signals',
  },
};

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Evaluate all tripwire conditions for a user and fire events.
 */
export async function evaluateTripwires(
  db: D1Database,
  userId: string,
  pipelineRunId: string | null,
  metrics: TripwireMetrics
): Promise<TripwireEvent[]> {
  const events: TripwireEvent[] = [];

  // spend_without_delivery: credits used but no successful generations
  if (
    metrics.creditsUsed > TRIPWIRE_THRESHOLDS.credit_burn_warning &&
    metrics.totalGenerations === 0
  ) {
    const ev = await fireTripwire(db, {
      tripwire: 'spend_without_delivery',
      user_id: userId,
      pipeline_run_id: pipelineRunId,
      condition_detail: `${metrics.creditsUsed} credits used, 0 successful generations`,
      condition_key: '0_success',
    });
    if (ev) events.push(ev);
  }

  // burn_rate_exceeded: simulation-evolved threshold (Butterfly v7: 27 credits/min)
  if (metrics.burnRate > TRIPWIRE_THRESHOLDS.burn_rate_per_min) {
    const ev = await fireTripwire(db, {
      tripwire: 'burn_rate_exceeded',
      user_id: userId,
      pipeline_run_id: pipelineRunId,
      condition_detail: `Burn rate ${metrics.burnRate.toFixed(1)} credits/min exceeds threshold of ${TRIPWIRE_THRESHOLDS.burn_rate_per_min}`,
      condition_key: '50',
    });
    if (ev) events.push(ev);
  }

  // credit_depletion: credits below 10% of starting
  if (metrics.creditsRemaining < 100) {
    const ev = await fireTripwire(db, {
      tripwire: 'credit_depletion',
      user_id: userId,
      pipeline_run_id: pipelineRunId,
      condition_detail: `Credits remaining: ${metrics.creditsRemaining}`,
      condition_key: '100',
    });
    if (ev) events.push(ev);
  }

  // failed_generation_streak: 3+ consecutive failures
  if (metrics.failedGenerations >= 3) {
    const ev = await fireTripwire(db, {
      tripwire: 'failed_generation_streak',
      user_id: userId,
      pipeline_run_id: pipelineRunId,
      condition_detail: `${metrics.failedGenerations} consecutive failures`,
      condition_key: '3',
    });
    if (ev) events.push(ev);
  }

  // api_error_spike: error rate > 20%
  if (metrics.errorRate > 0.2) {
    const ev = await fireTripwire(db, {
      tripwire: 'api_error_spike',
      user_id: userId,
      pipeline_run_id: pipelineRunId,
      condition_detail: `Error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds 20%`,
      condition_key: '0.2',
    });
    if (ev) events.push(ev);
  }

  return events;
}

/**
 * Fire a tripwire event with dedup via condition_hash.
 * Returns null if the event already exists (dedup).
 */
export async function fireTripwire(
  db: D1Database,
  params: {
    tripwire: string;
    user_id: string | null;
    pipeline_run_id: string | null;
    condition_detail: string;
    condition_key: string;
    retry_attempt?: number;
  }
): Promise<TripwireEvent | null> {
  const config = TRIPWIRE_CONFIG[params.tripwire];
  if (!config) return null;

  const retry = params.retry_attempt ?? 0;
  const hashInput = `${params.tripwire}:${params.user_id ?? 'null'}:${params.pipeline_run_id ?? 'null'}:${params.condition_key}:${retry}`;
  const conditionHash = await sha256Hex(hashInput);

  // Check for existing event (dedup)
  const existing = await db
    .prepare('SELECT id FROM tripwire_events WHERE condition_hash = ?')
    .bind(conditionHash)
    .first<{ id: string }>();

  if (existing) return null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO tripwire_events (id, tripwire, user_id, pipeline_run_id, severity, condition_detail, condition_hash, remedy, remedy_status, retry_attempt, actor_type, created_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'system', ?)`
    )
    .bind(
      id,
      params.tripwire,
      params.user_id,
      params.pipeline_run_id,
      config.severity,
      params.condition_detail,
      conditionHash,
      config.remedy,
      retry,
      now
    )
    .run();

  return {
    id,
    tripwire: params.tripwire,
    user_id: params.user_id,
    pipeline_run_id: params.pipeline_run_id,
    severity: config.severity,
    condition_detail: params.condition_detail,
    condition_hash: conditionHash,
    remedy: config.remedy,
    remedy_status: 'pending',
    remedy_idempotency_key: null,
    retry_attempt: retry,
    actor_type: 'system',
    created_date: now,
    resolved_date: null,
  };
}

/**
 * Execute a pending remedy for a tripwire event.
 */
export async function executeRemedy(
  db: D1Database,
  eventId: string
): Promise<void> {
  const event = await db
    .prepare('SELECT * FROM tripwire_events WHERE id = ? AND remedy_status = ?')
    .bind(eventId, 'pending')
    .first<TripwireEvent>();

  if (!event) return;

  const remedyKey = `remedy:${event.id}`;

  // Set idempotency key
  await db
    .prepare(
      'UPDATE tripwire_events SET remedy_idempotency_key = ? WHERE id = ? AND remedy_idempotency_key IS NULL'
    )
    .bind(remedyKey, eventId)
    .run();

  try {
    // Execute remedy based on type
    switch (event.remedy) {
      case 'pause':
        if (event.pipeline_run_id) {
          await db
            .prepare('UPDATE pipeline_runs SET status = ? WHERE id = ?')
            .bind('paused', event.pipeline_run_id)
            .run();
        }
        break;
      case 'block':
        if (event.user_id) {
          await db
            .prepare('UPDATE users SET is_banned = 1 WHERE id = ?')
            .bind(event.user_id)
            .run();
        }
        break;
      case 'refund':
        if (event.user_id) {
          // Issue credit refund
          await db
            .prepare(
              `INSERT INTO credit_ledger (id, user_id, amount, type, description, created_date)
             VALUES (?, ?, 500, 'credit', 'Tripwire refund', ?)`
            )
            .bind(crypto.randomUUID(), event.user_id, new Date().toISOString())
            .run();
        }
        break;
      case 'alert':
      case 'notify':
      case 'escalate':
        // Log to audit_log — no automatic action needed
        await db
          .prepare(
            `INSERT INTO audit_log (id, event_type, severity, user_id, details, created_date)
           VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            'tripwire_alert',
            event.severity,
            event.user_id,
            event.condition_detail,
            new Date().toISOString()
          )
          .run();
        break;
      case 'auto_grant':
        // Auto-grant credits to prevent churn
        if (event.user_id) {
          await db
            .prepare(
              'UPDATE users SET credits_remaining = credits_remaining + 200 WHERE id = ?'
            )
            .bind(event.user_id)
            .run();
        }
        break;
    }

    await db
      .prepare(
        'UPDATE tripwire_events SET remedy_status = ?, resolved_date = ? WHERE id = ?'
      )
      .bind('applied', new Date().toISOString(), eventId)
      .run();
  } catch (err) {
    await db
      .prepare('UPDATE tripwire_events SET remedy_status = ? WHERE id = ?')
      .bind('failed', eventId)
      .run();
    throw err;
  }
}

/**
 * Get all pending remedies for cron processing.
 */
export async function getPendingRemedies(
  db: D1Database
): Promise<TripwireEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM tripwire_events WHERE remedy_status = 'pending' ORDER BY created_date ASC LIMIT 100`
    )
    .all<TripwireEvent>();
  return results;
}

/**
 * Handle a failed remedy — creates a retry event (max 3 retries).
 */
export async function handleRetry(
  db: D1Database,
  failedEventId: string
): Promise<TripwireEvent | null> {
  const failed = await db
    .prepare('SELECT * FROM tripwire_events WHERE id = ?')
    .bind(failedEventId)
    .first<TripwireEvent>();

  if (!failed) return null;
  if (failed.retry_attempt >= MAX_RETRIES) return null;

  return fireTripwire(db, {
    tripwire: failed.tripwire,
    user_id: failed.user_id,
    pipeline_run_id: failed.pipeline_run_id,
    condition_detail: `Retry ${failed.retry_attempt + 1}: ${failed.condition_detail}`,
    condition_key: failed.condition_hash.slice(0, 16),
    retry_attempt: failed.retry_attempt + 1,
  });
}

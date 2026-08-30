/**
 * Decline Recovery — Dunning workflow for failed Stripe payments.
 * See 07_STATE_MACHINE_CONTRACTS/state-machines.yaml §dunning.
 */
import type { Env } from '../env.js';

export interface DunningWorkflow {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_invoice_id: string | null;
  decline_reason: string | null;
  retry_count: number;
  max_retries: number;
  next_retry_at: string | null;
  status: 'active' | 'recovered' | 'exhausted' | 'cancelled';
  grace_period_end: string;
  created_date: string;
  updated_date: string;
}

const RETRY_DELAYS_MS = [
  1 * 60 * 60 * 1000,       // 1 hour
  6 * 60 * 60 * 1000,       // 6 hours
  24 * 60 * 60 * 1000,      // 24 hours
  72 * 60 * 60 * 1000,      // 72 hours
  168 * 60 * 60 * 1000,     // 168 hours (7 days)
];

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function createDunningWorkflow(
  db: D1Database,
  userId: string,
  customerId: string,
  subscriptionId: string,
  invoiceId: string | null,
  declineReason: string | null
): Promise<DunningWorkflow> {
  const now = new Date();
  const graceEnd = new Date(now.getTime() + GRACE_PERIOD_MS);
  const firstRetry = new Date(now.getTime() + RETRY_DELAYS_MS[0]);
  const id = crypto.randomUUID();

  await db.prepare(
    `INSERT INTO dunning_workflow (id, user_id, stripe_customer_id, stripe_subscription_id, stripe_invoice_id,
      decline_reason, retry_count, max_retries, next_retry_at, status, grace_period_end, created_date, updated_date)
     VALUES (?, ?, ?, ?, ?, ?, 0, 5, ?, 'active', ?, ?, ?)`
  ).bind(id, userId, customerId, subscriptionId, invoiceId, declineReason, firstRetry.toISOString(), graceEnd.toISOString(), now.toISOString(), now.toISOString()).run();

  return (await db.prepare('SELECT * FROM dunning_workflow WHERE id = ?').bind(id).first<DunningWorkflow>())!;
}

export async function processRetry(db: D1Database, workflowId: string): Promise<{ status: string; nextRetryAt?: string }> {
  const wf = await db.prepare('SELECT * FROM dunning_workflow WHERE id = ?').bind(workflowId).first<DunningWorkflow>();
  if (!wf) throw new Error('Workflow not found');
  if (wf.status !== 'active') return { status: wf.status };

  if (wf.retry_count >= wf.max_retries) {
    await exhaustWorkflow(db, workflowId);
    return { status: 'exhausted' };
  }

  const now = new Date();
  if (wf.next_retry_at && new Date(wf.next_retry_at) > now) {
    return { status: 'active', nextRetryAt: wf.next_retry_at };
  }

  const nextRetryCount = wf.retry_count + 1;
  const delayIndex = Math.min(wf.retry_count, RETRY_DELAYS_MS.length - 1);
  const nextRetry = new Date(now.getTime() + RETRY_DELAYS_MS[delayIndex]);

  await db.prepare(
    `UPDATE dunning_workflow SET retry_count = ?, next_retry_at = ?, updated_date = ? WHERE id = ?`
  ).bind(nextRetryCount, nextRetry.toISOString(), now.toISOString(), workflowId).run();

  return { status: 'active', nextRetryAt: nextRetry.toISOString() };
}

export async function recoverWorkflow(db: D1Database, workflowId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE dunning_workflow SET status = 'recovered', updated_date = ? WHERE id = ?`
  ).bind(now, workflowId).run();

  // Restore entitlements
  const wf = await db.prepare('SELECT user_id FROM dunning_workflow WHERE id = ?').bind(workflowId).first<{ user_id: string }>();
  if (wf) {
    await db.prepare(
      `DELETE FROM entitlements WHERE user_id = ? AND reason = 'dunning'`
    ).bind(wf.user_id).run();
  }
}

export async function exhaustWorkflow(db: D1Database, workflowId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE dunning_workflow SET status = 'exhausted', updated_date = ? WHERE id = ?`
  ).bind(now, workflowId).run();

  // Degrade entitlements
  const wf = await db.prepare('SELECT user_id FROM dunning_workflow WHERE id = ?').bind(workflowId).first<{ user_id: string }>();
  if (wf) {
    await db.prepare(
      `INSERT OR REPLACE INTO entitlements (id, user_id, feature, access, reason, actor_type, actor_id, created_date, updated_date)
       VALUES (?, ?, 'pipeline', 'degrade', 'dunning', 'system', ?, ?, ?)`
    ).bind(crypto.randomUUID(), wf.user_id, workflowId, now, now).run();
  }
}

export async function getActiveWorkflows(db: D1Database): Promise<DunningWorkflow[]> {
  const now = new Date().toISOString();
  const { results } = await db.prepare(
    `SELECT * FROM dunning_workflow WHERE status = 'active' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY next_retry_at ASC LIMIT 50`
  ).bind(now).all<DunningWorkflow>();
  return results;
}

export async function checkGracePeriod(db: D1Database, workflowId: string): Promise<boolean> {
  const wf = await db.prepare('SELECT grace_period_end FROM dunning_workflow WHERE id = ?').bind(workflowId).first<{ grace_period_end: string }>();
  if (!wf) return false;
  return new Date(wf.grace_period_end) > new Date();
}

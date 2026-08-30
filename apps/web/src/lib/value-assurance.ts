/**
 * Value Assurance — the North Star.
 *
 * "Know when a user is not getting what they are paying for —
 *  and catch it before they tell you, and before it is too late."
 *
 * Layer 1: The Outcome Ledger (append-only event log)
 * Layer 2: Deterministic tripwires (real-time, no ML)
 * Layer 3: Semantic dissatisfaction detection (uses the Cohere lattice)
 * Layer 4: Act before they tell you (auto-remedy)
 * Layer 5: Governing metrics
 *
 * Credit prioritization rule: when budget is contested, spend order is
 * (1) Verifier assertions, (2) Value Assurance detection, (3) repair of
 * a failed paid intent, (4) new feature generation, (5) polish.
 * Generation never outbids verification.
 */

export type OutcomeState =
  | 'pending'
  | 'delivered'
  | 'degraded'
  | 'failed'
  | 'abandoned'
  | 'refunded';

export interface OutcomeEvent {
  id: string;
  tenant: string;
  user: string;
  intent_id: string;
  event: string;
  spend_credits: number;
  outcome_state: OutcomeState;
  latency_ms: number;
  error_class: string | null;
  timestamp: number;
}

export interface Tripwire {
  id: string;
  name: string;
  description: string;
  condition: (events: OutcomeEvent[]) => boolean;
  remedy: string;
  severity: 'critical' | 'high' | 'medium';
  lastFired: number | null;
}

/**
 * The 11 deterministic tripwires from the blueprint (§7, Layer 2).
 * Each fires within seconds and has a defined automatic remedy.
 */
export const TRIPWIRES: Tripwire[] = [
  {
    id: 'spend_without_delivery',
    name: 'Spend without delivery',
    description: 'Credits burned >= N on an intent with no delivered outcome',
    severity: 'critical',
    lastFired: null,
    condition: (events) => {
      const byIntent = groupByIntent(events);
      for (const [intentId, intentEvents] of byIntent) {
        const totalSpend = intentEvents.reduce(
          (s, e) => s + e.spend_credits,
          0
        );
        const hasDelivered = intentEvents.some(
          (e) => e.outcome_state === 'delivered'
        );
        if (totalSpend >= 20 && !hasDelivered) return true;
      }
      return false;
    },
    remedy: 'pause run, refund provisional credits, surface plan diff',
  },
  {
    id: 'silent_failure',
    name: 'Silent failure',
    description: 'Build/deploy green but Verifier assertions fail',
    severity: 'critical',
    lastFired: null,
    condition: (events) => {
      const recent = events.slice(-20);
      const hasDeployed = recent.some((e) => e.event === 'deploy_success');
      const hasVerifierFail = recent.some(
        (e) => e.event === 'verifier_assertion_failed'
      );
      return hasDeployed && hasVerifierFail;
    },
    remedy: 'block "done" state, open defect, notify user',
  },
  {
    id: 'loop_burn',
    name: 'Loop burn',
    description: '>3 agent steps with no diff accepted, or same error class x3',
    severity: 'high',
    lastFired: null,
    condition: (events) => {
      const recent = events.slice(-10);
      const noDiff = recent.filter(
        (e) => e.event === 'agent_step' && e.outcome_state === 'pending'
      ).length;
      const sameError = recent.filter(
        (e) => e.error_class && e.error_class === recent[0]?.error_class
      ).length;
      return noDiff > 3 || sameError >= 3;
    },
    remedy: 'Steward halts, escalates to human with 3 candidate causes',
  },
  {
    id: 'first_run_cliff',
    name: 'First-run cliff',
    description: 'New paid user, 0 delivered outcomes in first 24h',
    severity: 'high',
    lastFired: null,
    condition: (events) => {
      const user = events[0]?.user;
      if (!user) return false;
      const firstEvent = events[0];
      const hasDelivered = events.some(
        (e) => e.user === user && e.outcome_state === 'delivered'
      );
      const isWithin24h =
        Date.now() - firstEvent.timestamp < 24 * 60 * 60 * 1000;
      return isWithin24h && !hasDelivered && events.length > 5;
    },
    remedy: 'in-app rescue + human outreach queue',
  },
  {
    id: 'preview_divergence',
    name: 'Preview divergence',
    description: 'UI preview OK but Glass Engine shows 5xx / RLS denials',
    severity: 'high',
    lastFired: null,
    condition: (events) => {
      const recent = events.slice(-15);
      const previewOk = recent.some((e) => e.event === 'preview_ok');
      const hasErrors = recent.some(
        (e) => e.error_class === '5xx' || e.error_class === 'rls_denied'
      );
      return previewOk && hasErrors;
    },
    remedy: 'flag "your app looks fine and is broken"',
  },
  {
    id: 'entitlement_drift',
    name: 'Entitlement drift',
    description: 'User on paid tier hitting deny/degrade',
    severity: 'critical',
    lastFired: null,
    condition: (events) => {
      return events.some(
        (e) => e.event === 'entitlement_check' && e.outcome_state === 'degraded'
      );
    },
    remedy: 'auto-grant + alert (never let billing block a payer)',
  },
  {
    id: 'recurring_decline',
    name: 'Recurring decline',
    description: 'Renewal declined (reason code captured)',
    severity: 'high',
    lastFired: null,
    condition: (events) => {
      return events.some(
        (e) => e.event === 'payment_declined' && e.error_class === 'renewal'
      );
    },
    remedy:
      'retry ladder + account updater + dunning; preserve access through grace window',
  },
  {
    id: 'latency_regression',
    name: 'Latency/cost regression',
    description: 'p95 or credits-per-intent up 2x vs 7-day baseline',
    severity: 'medium',
    lastFired: null,
    condition: (events) => {
      const recent = events.slice(-50);
      const recentP95 = percentile(
        recent.map((e) => e.latency_ms).filter((l) => l > 0),
        95
      );
      const older = events.slice(0, -50);
      const olderP95 = percentile(
        older.map((e) => e.latency_ms).filter((l) => l > 0),
        95
      );
      return olderP95 > 0 && recentP95 > olderP95 * 2;
    },
    remedy: 'freeze, diff the causing commit',
  },
  {
    id: 'abandonment',
    name: 'Abandonment',
    description: 'Session ends < 60s after a failed outcome',
    severity: 'high',
    lastFired: null,
    condition: (events) => {
      const lastFailed = events.slice().reverse().find((e) => e.outcome_state === 'failed');
      if (!lastFailed) return false;
      const sessionEnd = events.slice().reverse().find((e) => e.event === 'session_end');
      if (!sessionEnd) return false;
      return sessionEnd.timestamp - lastFailed.timestamp < 60000;
    },
    remedy: 'immediate credit-back + follow-up',
  },
];

/**
 * Evaluate all tripwires against the outcome ledger.
 * Returns fired tripwires with their remedies.
 */
export function evaluateTripwires(events: OutcomeEvent[]): Array<{
  tripwire: Tripwire;
  firedAt: number;
}> {
  const fired: Array<{ tripwire: Tripwire; firedAt: number }> = [];
  for (const tw of TRIPWIRES) {
    if (tw.condition(events)) {
      fired.push({ tripwire: tw, firedAt: Date.now() });
    }
  }
  return fired;
}

/**
 * Value Realization Rate = delivered / entitled outcomes (primary metric).
 */
export function valueRealizationRate(events: OutcomeEvent[]): number {
  const entitled = events.filter((e) =>
    ['pending', 'delivered', 'degraded', 'failed'].includes(e.outcome_state)
  );
  const delivered = events.filter((e) => e.outcome_state === 'delivered');
  if (entitled.length === 0) return 0;
  return delivered.length / entitled.length;
}

/**
 * Silent Failure Rate = failures we detected / total failures.
 * Target: > 90% detected by us, not reported by users.
 */
export function silentFailureRate(events: OutcomeEvent[]): number {
  const failures = events.filter((e) => e.outcome_state === 'failed');
  const detectedByUs = failures.filter(
    (e) => e.event !== 'user_reported_error'
  );
  if (failures.length === 0) return 1;
  return detectedByUs.length / failures.length;
}

/**
 * Credits per delivered outcome — the honest efficiency number.
 */
export function creditsPerDelivered(events: OutcomeEvent[]): number {
  const delivered = events.filter((e) => e.outcome_state === 'delivered');
  if (delivered.length === 0) return 0;
  const totalCredits = events.reduce((s, e) => s + e.spend_credits, 0);
  return totalCredits / delivered.length;
}

// --- Utilities ---

function groupByIntent(events: OutcomeEvent[]): Map<string, OutcomeEvent[]> {
  const map = new Map<string, OutcomeEvent[]>();
  for (const e of events) {
    const list = map.get(e.intent_id) ?? [];
    list.push(e);
    map.set(e.intent_id, list);
  }
  return map;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

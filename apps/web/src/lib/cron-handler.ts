/**
 * Cron Handler — routes scheduled events to the correct worker
 * based on event.cron. See PHASE-0-PREFLIGHT.md §cron.
 */
import type { Env } from '../env.js';
import {
  evaluateTripwires,
  getPendingRemedies,
  executeRemedy,
  handleRetry,
} from './tripwires.js';
import {
  getActiveWorkflows,
  processRetry,
  exhaustWorkflow,
  checkGracePeriod,
} from './decline-recovery.js';
import { notifySlackBestEffort } from './slack.js';
import { runNightlyPreferenceLearning } from './preference-learning.js';
import {
  evaluateSimulationHealth,
  type SimulationSnapshot,
} from './simulation-watchdog.js';
import { selfChecks } from '../routes/compliance.js';
import {
  TIER_LIMITS,
  TIER_SUBSCRIPTION_PRICES,
} from '@bicameral/shared/constants';

/**
 * Handle a scheduled cron event by routing to the correct handler.
 */
export async function handleCron(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const cron = event.cron;

  switch (cron) {
    case '0 3 * * *':
      await handleDailyCreditReset(env);
      break;
    case '*/15 * * * *':
      await handleTripwireEngine(env);
      break;
    case '0 * * * *':
      await handleDunningWorker(env);
      break;
    case '0 4 * * *':
      await handleNightlyPreferenceLearning(env);
      break;
    case '0 6 * * *':
      await handleSimulationWatchdog(env);
      break;
    case '0 */6 * * *':
      await handleComplianceDrift(env);
      break;
    default:
      // A cron in wrangler.toml with no case here fires daily and does
      // nothing, silently — the same shape of defect as a green check that
      // never ran. `cron-coverage.test.ts` reads both files and fails when
      // they disagree, so this branch is for a cron that reached production
      // config without reaching the repo, not for a forgotten case.
      console.log(`Unknown cron schedule: ${cron}`);
  }
}

/**
 * Daily at 3 AM UTC: credit reset + audit log archival.
 */
/**
 * The credit-grant statements, as pure functions.
 *
 * EXPORTED so the tests can execute THE SHIPPED STATEMENT rather than a copy
 * of it. `grant-schedule.test.ts` originally rebuilt this SQL itself, and the
 * copy promptly diverged from the original the first time the guard changed —
 * the test would have gone on proving that a string in a test file behaves
 * correctly while the product shipped something else. That is the same
 * measure-the-wrong-thing failure the §4B audit has now found three times in
 * this area, so the copy is deleted rather than guarded.
 *
 * Tiers and figures are derived from TIER_LIMITS, never restated: the pricing
 * fix moved the constants while three hardcoded literals here went on paying
 * the old grants.
 */
export function grantedTiers(): (keyof typeof TIER_LIMITS)[] {
  return (Object.keys(TIER_LIMITS) as (keyof typeof TIER_LIMITS)[]).filter(
    (t) => t !== 'free'
  );
}

/** `CASE WHEN <col> = 'pro' THEN 1000 ... END` — a tier column to its grant. */
function grantOf(col: string): string {
  return `CASE ${grantedTiers()
    .map((t) => `WHEN ${col} = '${t}' THEN ${TIER_LIMITS[t].creditsPerMonth}`)
    .join(' ')} ELSE 0 END`;
}

/**
 * Demote nonprofit accounts whose grant is no longer in force, and CLAMP THE
 * BALANCE as well as the tier.
 *
 * Demoting alone left credits_remaining at the nonprofit grant, and the grant
 * statement excludes 'free', so nothing ever reduced it: a revoked account
 * went on spending team-volume credits indefinitely, which is the loss the
 * revocation exists to stop. MIN() so revocation cannot top an account UP.
 *
 * The conditions mirror `grantIsActive()`: revoked, unattributed, or no row.
 */
export function demoteRevokedGrantsSql(): string {
  return `UPDATE users
        SET tier = 'free',
            credits_remaining = MIN(credits_remaining, ${TIER_LIMITS.free.creditsPerMonth}),
            credits_granted_tier = 'free'
     WHERE tier = 'nonprofit'
       AND id NOT IN (
         SELECT user_id FROM nonprofit_grants
         WHERE revoked_at IS NULL
           AND granted_by IS NOT NULL
           AND trim(granted_by) <> ''
       )`;
}

/**
 * Pay the monthly grant, at most once per calendar month per entitlement.
 *
 * Takes the period (YYYY-MM, UTC) as ?1.
 *
 * A MONTHLY grant was being paid by a DAILY cron: this handler runs on
 * "0 3 * * *" and set credits_remaining to the monthly figure every morning,
 * so a Pro subscriber who spent each refill drew 30 x 1,000 = 30,000 credits a
 * month — 1,200 apps, $342 of delivery against $29 of revenue.
 * pricing-solvency.test.ts could not see it: every assertion there reasons
 * about TIER_LIMITS, and this lived in the SCHEDULE, which no test read.
 *
 * Guarded on a recorded date rather than a monthly cron, because a missed
 * monthly run would cost a subscriber their whole month and a double run would
 * pay twice. Keyed on (month, TIER GRANTED) rather than month alone: keyed on
 * the month alone it punished a paying customer, refusing to grant to a Pro
 * subscriber who downgraded on the 5th and resubscribed on the 10th until
 * October.
 *
 * A NEW MONTH RESETS; a same-month upgrade TOPS UP THE DIFFERENCE. That
 * distinction keeps the grant a monthly allowance rather than a rolling
 * balance — rollover would quietly stop the grant being the per-month ceiling
 * the pricing is derived against — and it is what makes reopening the guard
 * safe: free -> pro -> free -> pro cannot farm grants, because the second
 * upgrade finds credits_granted_tier already 'pro' for the month and the
 * difference is zero.
 */
/**
 * Tiers that are SOLD, derived from TIER_SUBSCRIPTION_PRICES.
 *
 * A sold tier must have an active subscription behind it to be granted; a
 * PROVISIONED tier (nonprofit grant, enterprise contract) has no subscription
 * by design. Derived rather than listed, so a new paid tier is covered the day
 * it gains a price.
 */
function soldTiers(): string[] {
  return Object.keys(TIER_SUBSCRIPTION_PRICES).filter((t) => t !== 'free');
}

/**
 * The billing reference a grant is keyed to.
 *
 * Keyed on the calendar month alone, the guard produced two requirements that
 * could not both hold — a resubscriber who paid again must be granted, and a
 * tier-cycler must not be — and no rule over (month, tier) satisfies both. The
 * distinguishing fact is which BILLING PERIOD was paid for.
 *
 * For a sold tier that is `<period>:<subscription id>:<current_period_end>`.
 * The period end is part of it because Stripe PRESERVES the subscription id
 * across cancel-and-reactivate: keyed on the id alone, a subscriber who
 * cancelled mid-month, spent down, then reactivated and paid on the 15th would
 * compute the same reference and receive nothing for the rest of the month —
 * the very failure this keying was introduced to fix, surviving in a variant
 * the first test suite did not cover. The §4B audit found it.
 *
 * For a provisioned tier it is `<period>:-`, i.e. plain calendar month. The
 * fallback is a CONSTANT, never the tier name: a downgrade would otherwise
 * fabricate a new reference and reset the balance, and a downgrade is not a
 * billing event. `migrations/032` backfills using this same constant, and
 * `grant-schedule.test.ts` asserts the two agree — they did not, and the
 * mismatch made every backfilled row look unpaid and double-granted.
 */
export const PROVISIONED_REF_FALLBACK = '-';

function grantRefExpr(): string {
  return `?1 || ':' || COALESCE(
         (SELECT s.stripe_subscription_id || ':' || COALESCE(s.current_period_end, '')
            FROM subscriptions s
           WHERE s.user_id = users.id
             AND s.status = 'active'
        ORDER BY s.created_date DESC
           LIMIT 1),
         '${PROVISIONED_REF_FALLBACK}'
       )`;
}

/**
 * A sold tier with no active subscription is not granted.
 *
 * Without this the keying leaked: an account left at tier='pro' after its
 * subscription was cancelled — a webhook failure, a manual edit — computed a
 * stable reference and collected a full Pro grant every month with no billing
 * event behind it, indefinitely. That is the unbounded loss the billing-event
 * keying exists to prevent, reintroduced by the keying itself. Found by the
 * §4B audit.
 */
function hasActiveSubscriptionExpr(): string {
  return `EXISTS (
         SELECT 1 FROM subscriptions s
          WHERE s.user_id = users.id AND s.status = 'active'
       )`;
}

/**
 * Pay the monthly grant, at most once per billing reference. Period (YYYY-MM,
 * UTC) as ?1.
 *
 * A MONTHLY grant was being paid by a DAILY cron: this handler runs on
 * "0 3 * * *" and set credits_remaining to the monthly figure every morning,
 * so a Pro subscriber who spent each refill drew 30 x 1,000 = 30,000 credits a
 * month — 1,200 apps, $342 of delivery against $29 of revenue.
 * pricing-solvency.test.ts could not see it: every assertion there reasons
 * about TIER_LIMITS, and this lived in the SCHEDULE, which no test read.
 *
 * A NEW REFERENCE RESETS; a same-reference upgrade TOPS UP THE DIFFERENCE.
 * The reset keeps the grant a monthly allowance rather than a rolling balance
 * — rollover would quietly stop the grant being the per-month ceiling the
 * pricing is derived against.
 */
export function monthlyGrantSql(): string {
  const tierList = grantedTiers()
    .map((t) => `'${t}'`)
    .join(', ');
  const soldList = soldTiers()
    .map((t) => `'${t}'`)
    .join(', ');
  const ref = grantRefExpr();
  return `UPDATE users SET credits_remaining =
       CASE
         WHEN credits_granted_ref IS NULL OR credits_granted_ref <> (${ref})
         THEN ${grantOf('tier')}
         ELSE credits_remaining
              + (${grantOf('tier')} - ${grantOf('credits_granted_tier')})
       END,
       credits_granted_at = ?1,
       credits_granted_tier = tier,
       credits_granted_ref = (${ref})
     WHERE tier IN (${tierList})
       AND (tier NOT IN (${soldList}) OR ${hasActiveSubscriptionExpr()})
       AND (
         credits_granted_ref IS NULL
         OR credits_granted_ref <> (${ref})
         OR ${grantOf('tier')} > ${grantOf('credits_granted_tier')}
       )`;
}

/**
 * The grant period: YYYY-MM in UTC.
 *
 * toISOString() is UTC per spec, independent of the host, and Cloudflare
 * evaluates cron triggers in UTC. Both halves matter — the month boundary is
 * stable only while the schedule and the stamp agree on a timezone.
 */
export function grantPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

async function handleDailyCreditReset(env: Env): Promise<void> {
  const demoted = await env.DB.prepare(demoteRevokedGrantsSql()).run();
  if ((demoted.meta?.changes ?? 0) > 0) {
    console.log(
      `Nonprofit reconcile: ${demoted.meta?.changes} account(s) demoted to free ` +
        '(grant revoked, unattributed, or missing)'
    );
  }

  const period = grantPeriod();
  const granted = await env.DB.prepare(monthlyGrantSql()).bind(period).run();
  console.log(
    `Monthly grant: ${granted.meta?.changes ?? 0} account(s) topped up for ${period}`
  );

  // Archive old audit logs (older than 90 days)
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`DELETE FROM audit_log WHERE created_date < ?`)
    .bind(cutoff)
    .run();

  console.log('Daily credit reset + audit archival complete');
}

/**
 * Every 15 min: tripwire engine — evaluate conditions and execute pending remedies.
 */
async function handleTripwireEngine(env: Env): Promise<void> {
  // Execute pending remedies
  const pending = await getPendingRemedies(env.DB);

  for (const event of pending) {
    try {
      await executeRemedy(env.DB, event.id);
    } catch (err) {
      console.error(`Remedy failed for ${event.id}:`, err);
      await handleRetry(env.DB, event.id);
    }
  }

  if (pending.length > 0) {
    console.log(
      `Tripwire engine: processed ${pending.length} pending remedies`
    );
  }
}

/**
 * Hourly: dunning worker — process active workflows and schedule retries.
 */
async function handleDunningWorker(env: Env): Promise<void> {
  const active = await getActiveWorkflows(env.DB);

  for (const wf of active) {
    try {
      const result = await processRetry(env.DB, wf.id);

      if (result.status === 'exhausted') {
        console.log(`Dunning workflow ${wf.id} exhausted`);
      }

      // Check if grace period expired
      const inGrace = await checkGracePeriod(env.DB, wf.id);
      if (!inGrace && result.status === 'active') {
        await exhaustWorkflow(env.DB, wf.id);
        console.log(
          `Dunning workflow ${wf.id} grace period expired — entitlements degraded`
        );
      }
    } catch (err) {
      console.error(`Dunning retry failed for ${wf.id}:`, err);
    }
  }

  if (active.length > 0) {
    console.log(`Dunning worker: processed ${active.length} active workflows`);
  }
}

/**
 * Daily at 4 AM UTC: nightly preference learning — cluster corrections and extract rules.
 */
async function handleNightlyPreferenceLearning(env: Env): Promise<void> {
  try {
    const result = await runNightlyPreferenceLearning(env);
    console.log(
      `Preference learning: ${result.projectsProcessed} projects, ${result.rulesExtracted} rules extracted`
    );
  } catch (err) {
    console.error('Nightly preference learning failed:', err);
  }
}

/**
 * Daily at 6 AM UTC: read the last two Monte Carlo reports and raise alerts.
 *
 * Two hours after the 4 AM Actions schedule, which is enough for the run and
 * its ingest to have finished. It deliberately does NOT run the simulation —
 * the engine is Python and spends real credits against live production, and
 * neither of those belongs inside a Worker. This is the half that notices.
 *
 * It writes alerts and nothing else: no config, no tripwires, no knobs. See
 * the CONSTRAINT in lib/simulation-watchdog.ts.
 */
export async function handleSimulationWatchdog(env: Env): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, num_bots, total_credits_simulated, vdr_percent,
              exploits_found_json, tripwire_breakdown_json, created_date
       FROM simulation_runs
       WHERE status = 'completed'
       ORDER BY created_date DESC LIMIT 2`
    ).all<Record<string, unknown>>();

    const [latest, previous] = (rows.results ?? []).map(toSnapshot);

    const alerts = evaluateSimulationHealth({
      latest: latest ?? null,
      previous: previous ?? null,
      now: new Date(),
    });

    for (const alert of alerts) {
      // INSERT OR IGNORE against the unique dedupe_key: the cron reads the
      // same two rows every morning until a new report lands, so without
      // this a standing problem would re-raise daily and train whoever
      // reads the table to stop reading it.
      const written = await env.DB.prepare(
        `INSERT OR IGNORE INTO simulation_alerts
           (id, run_id, kind, severity, summary, detail, dedupe_key, created_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
        .bind(
          crypto.randomUUID(),
          alert.runId,
          alert.kind,
          alert.severity,
          alert.summary,
          alert.detail,
          alert.dedupeKey
        )
        .run();

      // Slack only on a row that was actually inserted. The dedupe argument
      // above applies with more force to a notification than to a table: a
      // standing problem re-announced every morning is how an alert channel
      // becomes something people mute, and a muted channel is worse than no
      // channel because it still looks like coverage.
      //
      // `meta.changes` is 0 when OR IGNORE suppressed the write. Deliberately
      // read from the result rather than doing a SELECT first — a check-then-
      // insert would notify twice if two crons ever overlapped.
      if (written.meta.changes > 0) {
        await notifySlackBestEffort(
          env,
          {
            text: `:warning: Simulation alert — *${alert.kind}* (${alert.severity})\n${alert.summary}`,
            fields: {
              Run: alert.runId ?? 'n/a',
              Severity: alert.severity,
              Detail: alert.detail,
            },
          },
          `simulation alert ${alert.dedupeKey}`
        );
      }
    }

    console.log(
      `Simulation watchdog: ${alerts.length} alert(s) evaluated from ${rows.results?.length ?? 0} run(s)`
    );
  } catch (err) {
    // Loud, and not swallowed into a success: a watchdog that fails quietly
    // is worse than no watchdog, because the empty alert table then reads as
    // "nothing is wrong".
    console.error('Simulation watchdog failed:', err);
    throw err;
  }
}

/** One `simulation_runs` row, reduced to what the watchdog compares. */
function toSnapshot(row: Record<string, unknown>): SimulationSnapshot {
  const exploits = safeParse<unknown[]>(row.exploits_found_json, []);
  const tripwires = safeParse<Record<string, number>>(
    row.tripwire_breakdown_json,
    {}
  );

  // The engine reports one entry per *bot* that tripped something, each
  // carrying the list of tripwires it tripped. The finding is the tripwire,
  // not the bot, so flatten and dedupe — otherwise two bots hitting the same
  // known tripwire reads as two new exploit classes.
  // The engine records each hit as "TW-03-credit-burn-no-value:<detail>";
  // the class is the part before the colon, which is also how the engine's own
  // tripwire_breakdown is keyed. Keeping the detail would make every night's
  // hits look new, and a "new exploit class" alert that fires every night is
  // one nobody reads.
  const classes = new Set<string>();
  for (const entry of exploits) {
    const names = (entry as { tripwires?: unknown }).tripwires;
    if (Array.isArray(names)) {
      for (const name of names) classes.add(String(name).split(':')[0]);
    } else if (typeof entry === 'string') {
      classes.add(entry.split(':')[0]);
    }
  }

  return {
    id: String(row.id),
    createdDate: String(row.created_date),
    numBots: Number(row.num_bots ?? 0),
    totalCreditsSimulated: Number(row.total_credits_simulated ?? 0),
    vdrPercent:
      row.vdr_percent === null || row.vdr_percent === undefined
        ? null
        : Number(row.vdr_percent),
    exploitClasses: [...classes],
    tripwireBreakdown: tripwires,
  };
}

function safeParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Every 6 hours: compliance drift.
 *
 * The CI workflow in the private governance repository gates every CHANGE. This
 * catches what CI cannot: the deployed system drifting away from the artefact
 * that was published about it, with nobody pushing anything. A green CI run on
 * a commit from three weeks ago says nothing about what is serving traffic now.
 *
 * It alerts only on a FAILING or EMPTY check. A check that examined nothing is
 * treated as a failure, not as a pass — the rule the governance package is
 * built on, applied to the thing the package is about.
 */
async function handleComplianceDrift(env: Env): Promise<void> {
  const checks = selfChecks(env);
  const failed = checks.filter((k) => !k.ok);
  const empty = checks.filter((k) => k.examined === 0);

  if (failed.length === 0 && empty.length === 0) {
    console.log(
      `compliance drift: green, ${checks.length} checks, ` +
        `${checks.reduce((n, k) => n + k.examined, 0)} things examined`
    );
    return;
  }

  const lines = [
    ...failed.map((k) => `FAILED ${k.name}: ${k.detail}`),
    ...empty.map(
      (k) => `MEASURED NOTHING ${k.name}: 0 ${k.unit} — reported as a failure`
    ),
  ];
  console.error(`compliance drift: RED\n${lines.join('\n')}`);
  await notifySlackBestEffort(
    env,
    {
      text: `:rotating_light: Compliance drift on discomplemented.com`,
      fields: {
        Failing: `${failed.length} of ${checks.length}`,
        'Measured nothing': `${empty.length} of ${checks.length}`,
        Detail: lines.join(' | ').slice(0, 900),
      },
    },
    'compliance-drift'
  );
}

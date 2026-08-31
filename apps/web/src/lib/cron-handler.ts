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
import { pruneChatMints } from './chat-quota.js';
import { pruneChatToolTokens } from './chat-tool-token.js';
import { runNightlyPreferenceLearning } from './preference-learning.js';
import {
  evaluateSimulationHealth,
  type SimulationSnapshot,
} from './simulation-watchdog.js';

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
async function handleDailyCreditReset(env: Env): Promise<void> {
  // Reset monthly credits for paying users
  await env.DB.prepare(
    `UPDATE users SET credits_remaining = CASE
      WHEN tier = 'pro' THEN 50000
      WHEN tier = 'team' THEN 200000
      WHEN tier = 'enterprise' THEN 1000000
      ELSE credits_remaining
    END
    WHERE tier IN ('pro', 'team', 'enterprise')`
  ).run();

  // Archive old audit logs (older than 90 days)
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`DELETE FROM audit_log WHERE created_date < ?`)
    .bind(cutoff)
    .run();

  // Chat mint rows past their retention window (lib/chat-quota.ts). Sharing
  // the 3 AM job rather than adding a cron: the prune is one indexed DELETE,
  // and a new schedule would need a matching case here and an entry in
  // wrangler.toml or cron-coverage.test.ts fails.
  const prunedMints = await pruneChatMints(env.DB);

  // Expired chat tool capability tokens (lib/chat-tool-token.ts), same job for
  // the same reason. Note this prune is hygiene, not enforcement: expiry is in
  // resolveChatToolToken's WHERE clause, so a missed run leaves dead rows, not
  // live tokens.
  const prunedTokens = await pruneChatToolTokens(env.DB);

  console.log(
    `Daily credit reset + audit archival complete (pruned ${prunedMints} chat ` +
      `mint rows, ${prunedTokens} expired chat tool tokens)`
  );
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

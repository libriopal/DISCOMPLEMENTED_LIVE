/**
 * Simulation watchdog — §3.5 item 6, "alert on regression".
 *
 * The Monte Carlo engine runs out of band, nightly, on a GitHub Actions
 * schedule, and POSTs its report to /api/simulation/ingest. That leaves two
 * failure modes that nobody would notice on their own: the run stops
 * happening, and the run happens and says something new and bad. A report
 * sitting unread in a table is the same as no simulation, which is what
 * §3.5 item 5 means by "surface findings loudly".
 *
 * This module decides. It is pure — snapshots in, alerts out, no database, no
 * clock of its own, no network. That is not tidiness: the thing worth pinning
 * is *which* changes count as a regression, and a function that reads its own
 * rows and its own clock cannot be asked about a run that has not happened.
 *
 * CONSTRAINT (§CORRECTION 7): this raises alerts and nothing else. There is
 * no write path from here to production config, tripwires, knobs, or the
 * engine's own parameters, and there must not be one. A system whose pitch is
 * that a human approves before anything ships cannot let unattended
 * simulation output rewrite its own behaviour. Auto-remediation is the §10
 * proposal, and the §10 proposal is gated on an explicit answer from the
 * account owner.
 */

/** One ingested run, reduced to the fields a regression can be seen in. */
export interface SimulationSnapshot {
  id: string;
  /** SQLite `datetime('now')` output, or any string `Date` can parse. */
  createdDate: string;
  numBots: number;
  totalCreditsSimulated: number;
  /** Null when the engine did not compute one. Not zero — see the note in
   * `movedMaterially`; a missing number and a bad number are different. */
  vdrPercent: number | null;
  /** Exploit *classes*, not instances: the tripwire names a bot tripped.
   * Two bots hitting the same tripwire is one class, and a class that was
   * never seen before is the finding. */
  exploitClasses: string[];
  tripwireBreakdown: Record<string, number>;
}

export type SimulationAlertKind =
  | 'no_run'
  | 'new_exploit_class'
  | 'vdr_regression'
  | 'tripwire_spike';

export interface SimulationAlert {
  kind: SimulationAlertKind;
  severity: 'high' | 'medium';
  /** One sentence, written for the person who will read it at 9am. */
  summary: string;
  /** The numbers behind the sentence, so the alert can be argued with. */
  detail: string;
  /** The run that triggered it; null when the trigger is a run's absence. */
  runId: string | null;
  /** Stable per (trigger, day) so re-running the watchdog does not re-raise
   * an alert that is already sitting in front of someone. The caller uses it
   * as a unique key. */
  dedupeKey: string;
}

/**
 * How long the nightly may be silent before that is itself the finding.
 *
 * The schedule is daily, so 24h is the expected gap and anything at 24h
 * exactly would alert on a run that merely started late. 26 gives the
 * Actions queue two hours, which is a policy choice and is written here as
 * one rather than buried as a literal at the call site.
 */
export const MAX_SILENCE_HOURS = 26;

/**
 * A VDR move worth waking someone for, in percentage points.
 *
 * This is a policy threshold, not a measurement, and it is worth being exact
 * about the difference. VDR itself has a derivation — `calculate_simulation_vdr`
 * in the engine, `lib/value-delivery-rate.ts` in the product — so the number
 * in the alert text is reproducible. How far it has to fall before it is
 * "material" is a judgement about how much noise a dozen-bot nightly carries,
 * and nothing here has measured that noise yet. Ten runs of history would
 * turn this into a measured band; until then it is a knob with a stated
 * default, and the alert quotes the two runs so the reader can disagree.
 */
export const VDR_REGRESSION_POINTS = 5;

/** A tripwire count has to both double and rise by this much. Doubling alone
 * fires on 1 → 2, which on a dozen bots is one bot having a bad night. */
export const TRIPWIRE_SPIKE_MIN_INCREASE = 3;

const HOUR_MS = 60 * 60 * 1000;

function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hoursSince(iso: string, now: Date): number | null {
  // SQLite's datetime('now') is 'YYYY-MM-DD HH:MM:SS' with no zone marker,
  // which Date parses as *local* time in some runtimes and UTC in others.
  // It is written by D1 in UTC, so say so rather than inheriting whichever
  // the host picks.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)
    ? `${iso.replace(' ', 'T')}Z`
    : iso;
  const then = Date.parse(normalized);
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / HOUR_MS;
}

/**
 * Decide what a human needs to be told about the last two nightly runs.
 *
 * `previous` may be null on the first ever run — a first report has nothing
 * to regress against, and reporting every exploit class in it as "new" would
 * make the first alert the loudest and least useful one.
 */
export function evaluateSimulationHealth(input: {
  latest: SimulationSnapshot | null;
  previous: SimulationSnapshot | null;
  now: Date;
  maxSilenceHours?: number;
}): SimulationAlert[] {
  const { latest, previous, now } = input;
  const maxSilence = input.maxSilenceHours ?? MAX_SILENCE_HOURS;

  if (!latest) {
    return [
      {
        kind: 'no_run',
        severity: 'high',
        summary: 'No simulation report has ever been ingested.',
        detail:
          'The nightly workflow (.github/workflows/simulation.yml) has never ' +
          'landed a row in simulation_runs. Either it has not run, or its ' +
          'ingest is failing — check the workflow run log and that ' +
          'SIMULATION_INGEST_SECRET matches the Worker secret.',
        runId: null,
        dedupeKey: `no_run:${day(now)}`,
      },
    ];
  }

  const age = hoursSince(latest.createdDate, now);
  if (age === null || age > maxSilence) {
    return [
      {
        kind: 'no_run',
        severity: 'high',
        summary:
          age === null
            ? 'The most recent simulation run has an unreadable timestamp.'
            : `The nightly simulation has not reported for ${Math.floor(age)} hours.`,
        detail:
          age === null
            ? `simulation_runs row ${latest.id} has created_date ` +
              `"${latest.createdDate}", which is not a parseable date. The ` +
              'watchdog cannot tell whether the nightly is running.'
            : `The last report landed ${Math.floor(age)} hours ago (run ` +
              `${latest.id}); the schedule is daily and the alerting ` +
              `threshold is ${maxSilence} hours. Check the workflow run log.`,
        runId: latest.id,
        dedupeKey: `no_run:${day(now)}`,
      },
    ];
  }

  // A run landed on time. Everything below compares it to the one before it,
  // so with no predecessor there is nothing more to say.
  if (!previous) return [];

  const alerts: SimulationAlert[] = [];

  const seenBefore = new Set(previous.exploitClasses);
  const appeared = latest.exploitClasses.filter((c) => !seenBefore.has(c));
  if (appeared.length > 0) {
    alerts.push({
      kind: 'new_exploit_class',
      severity: 'high',
      summary: `${appeared.length === 1 ? 'A new exploit class' : `${appeared.length} new exploit classes`} appeared in last night's simulation.`,
      detail:
        `New since run ${previous.id}: ${appeared.join(', ')}. ` +
        'Nothing has been changed in response — this is a finding for review, ' +
        'and any fix is a separate human-authored commit.',
      runId: latest.id,
      dedupeKey: `${latest.id}:new_exploit_class`,
    });
  }

  if (latest.vdrPercent !== null && previous.vdrPercent !== null) {
    const drop = previous.vdrPercent - latest.vdrPercent;
    if (drop >= VDR_REGRESSION_POINTS) {
      alerts.push({
        kind: 'vdr_regression',
        severity: 'medium',
        summary: `Value delivery rate fell ${round1(drop)} points overnight.`,
        detail:
          `VDR was ${round1(previous.vdrPercent)}% in run ${previous.id} and ` +
          `${round1(latest.vdrPercent)}% in run ${latest.id}, a drop of ` +
          `${round1(drop)} points against an alerting threshold of ` +
          `${VDR_REGRESSION_POINTS}. Both figures come from the engine's own ` +
          'per-turn classification; the threshold is a policy default, not a ' +
          'measured band.',
        runId: latest.id,
        dedupeKey: `${latest.id}:vdr_regression`,
      });
    }
  }

  for (const [tripwire, count] of Object.entries(latest.tripwireBreakdown)) {
    const before = previous.tripwireBreakdown[tripwire] ?? 0;
    const increase = count - before;
    if (increase >= TRIPWIRE_SPIKE_MIN_INCREASE && count >= before * 2) {
      alerts.push({
        kind: 'tripwire_spike',
        severity: 'medium',
        summary: `Tripwire "${tripwire}" fired ${count} times, up from ${before}.`,
        detail:
          `Run ${latest.id} tripped "${tripwire}" ${count} times against ` +
          `${before} in run ${previous.id} — at least double and at least ` +
          `${TRIPWIRE_SPIKE_MIN_INCREASE} more. Bot counts were ` +
          `${previous.numBots} and ${latest.numBots}; a spike alongside a ` +
          'larger bot pool may be the pool, not the system.',
        runId: latest.id,
        dedupeKey: `${latest.id}:tripwire_spike:${tripwire}`,
      });
    }
  }

  return alerts;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

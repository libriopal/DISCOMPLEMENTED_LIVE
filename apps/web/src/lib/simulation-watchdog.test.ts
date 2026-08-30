import { describe, it, expect } from 'vitest';
import {
  evaluateSimulationHealth,
  MAX_SILENCE_HOURS,
  VDR_REGRESSION_POINTS,
  TRIPWIRE_SPIKE_MIN_INCREASE,
  type SimulationSnapshot,
} from './simulation-watchdog.js';

const NOW = new Date('2026-09-01T06:00:00Z');

function snapshot(over: Partial<SimulationSnapshot> = {}): SimulationSnapshot {
  return {
    id: 'run-latest',
    createdDate: '2026-09-01 04:12:00',
    numBots: 12,
    totalCreditsSimulated: 96,
    vdrPercent: 70,
    exploitClasses: ['TW-03-credit-burn-no-value'],
    tripwireBreakdown: { 'TW-03-credit-burn-no-value': 4 },
    ...over,
  };
}

describe('evaluateSimulationHealth — the nightly stopped reporting', () => {
  it('alerts when nothing has ever been ingested', () => {
    const alerts = evaluateSimulationHealth({
      latest: null,
      previous: null,
      now: NOW,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('no_run');
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].runId).toBeNull();
    // Dated, not constant: a dead nightly should say so once a day, not once
    // ever and not once per cron tick.
    expect(alerts[0].dedupeKey).toBe('no_run:2026-09-01');
  });

  it('alerts when the last report is older than the silence window', () => {
    const stale = new Date(NOW.getTime() - (MAX_SILENCE_HOURS + 1) * 3600_000);
    const alerts = evaluateSimulationHealth({
      latest: snapshot({ createdDate: stale.toISOString() }),
      previous: snapshot({ id: 'run-prev' }),
      now: NOW,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('no_run');
    expect(alerts[0].detail).toContain('run-latest');
  });

  it('does not alert on a run inside the window', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot(),
      previous: snapshot({ id: 'run-prev' }),
      now: NOW,
    });
    expect(alerts).toEqual([]);
  });

  it("reads SQLite's zone-less timestamps as UTC", () => {
    // "2026-09-01 04:12:00" is two hours before NOW when read as UTC. Read as
    // local time in a host west of Greenwich it is in the future, and read in
    // a host far enough east it is stale — either way the watchdog would be
    // reporting the host's timezone rather than the pipeline's health.
    const alerts = evaluateSimulationHealth({
      latest: snapshot({ createdDate: '2026-09-01 04:12:00' }),
      previous: snapshot({ id: 'run-prev' }),
      now: NOW,
    });
    expect(alerts).toEqual([]);
  });

  it('alerts rather than guessing on an unparseable timestamp', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot({ createdDate: 'yesterday-ish' }),
      previous: snapshot({ id: 'run-prev' }),
      now: NOW,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('no_run');
    expect(alerts[0].summary).toContain('unreadable');
  });
});

describe('evaluateSimulationHealth — regressions', () => {
  it('is silent on the very first report', () => {
    // Everything in a first run is new. Reporting all of it as a regression
    // makes the loudest alert the least useful one.
    const alerts = evaluateSimulationHealth({
      latest: snapshot({
        exploitClasses: ['TW-01', 'TW-02', 'TW-03'],
        tripwireBreakdown: { 'TW-01': 9 },
      }),
      previous: null,
      now: NOW,
    });
    expect(alerts).toEqual([]);
  });

  it('raises a high alert for an exploit class that was not there before', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot({
        exploitClasses: ['TW-03-credit-burn-no-value', 'TW-04-approval-bypass'],
      }),
      previous: snapshot({
        id: 'run-prev',
        exploitClasses: ['TW-03-credit-burn-no-value'],
      }),
      now: NOW,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('new_exploit_class');
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].detail).toContain('TW-04-approval-bypass');
    expect(alerts[0].dedupeKey).toBe('run-latest:new_exploit_class');
  });

  it('does not alert when a known class simply recurs', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot({ exploitClasses: ['TW-03-credit-burn-no-value'] }),
      previous: snapshot({
        id: 'run-prev',
        exploitClasses: ['TW-03-credit-burn-no-value', 'TW-05'],
      }),
      now: NOW,
    });
    expect(alerts).toEqual([]);
  });

  it('alerts on a VDR drop at the threshold and not just below it', () => {
    const at = evaluateSimulationHealth({
      latest: snapshot({ vdrPercent: 70 }),
      previous: snapshot({
        id: 'run-prev',
        vdrPercent: 70 + VDR_REGRESSION_POINTS,
      }),
      now: NOW,
    });
    expect(at.map((a) => a.kind)).toEqual(['vdr_regression']);

    const under = evaluateSimulationHealth({
      latest: snapshot({ vdrPercent: 70 }),
      previous: snapshot({
        id: 'run-prev',
        vdrPercent: 70 + VDR_REGRESSION_POINTS - 0.1,
      }),
      now: NOW,
    });
    expect(under).toEqual([]);
  });

  it('does not alert when VDR improves', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot({ vdrPercent: 90 }),
      previous: snapshot({ id: 'run-prev', vdrPercent: 60 }),
      now: NOW,
    });
    expect(alerts).toEqual([]);
  });

  it('says nothing about VDR when either run did not compute one', () => {
    // A missing number and a bad number are different. Treating null as 0
    // would report a 70-point collapse every time the engine skipped it.
    const alerts = evaluateSimulationHealth({
      latest: snapshot({ vdrPercent: null }),
      previous: snapshot({ id: 'run-prev', vdrPercent: 70 }),
      now: NOW,
    });
    expect(alerts).toEqual([]);
  });

  it('alerts on a tripwire that both doubles and rises materially', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot({
        tripwireBreakdown: { 'TW-03-credit-burn-no-value': 8 },
      }),
      previous: snapshot({
        id: 'run-prev',
        tripwireBreakdown: { 'TW-03-credit-burn-no-value': 3 },
      }),
      now: NOW,
    });
    expect(alerts.map((a) => a.kind)).toEqual(['tripwire_spike']);
    expect(alerts[0].dedupeKey).toBe(
      'run-latest:tripwire_spike:TW-03-credit-burn-no-value'
    );
  });

  it('ignores a doubling that is only one or two extra hits', () => {
    // 1 → 2 doubles. On a dozen bots that is one bot having a bad night, and
    // an alert that fires on it is one that gets muted.
    const alerts = evaluateSimulationHealth({
      latest: snapshot({ tripwireBreakdown: { 'TW-08-timeout': 2 } }),
      previous: snapshot({
        id: 'run-prev',
        tripwireBreakdown: { 'TW-08-timeout': 1 },
      }),
      now: NOW,
    });
    expect(alerts).toEqual([]);
    expect(TRIPWIRE_SPIKE_MIN_INCREASE).toBeGreaterThan(2);
  });

  it('reports every finding in one pass rather than the first one', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot({
        exploitClasses: [
          'TW-03-credit-burn-no-value',
          'TW-09-unauthorized-access',
        ],
        vdrPercent: 50,
        tripwireBreakdown: { 'TW-03-credit-burn-no-value': 9 },
      }),
      previous: snapshot({
        id: 'run-prev',
        exploitClasses: ['TW-03-credit-burn-no-value'],
        vdrPercent: 80,
        tripwireBreakdown: { 'TW-03-credit-burn-no-value': 2 },
      }),
      now: NOW,
    });
    expect(alerts.map((a) => a.kind).sort()).toEqual([
      'new_exploit_class',
      'tripwire_spike',
      'vdr_regression',
    ]);
  });
});

describe('the auto-apply boundary', () => {
  it('returns advisory text only — no alert claims anything was changed', () => {
    const alerts = evaluateSimulationHealth({
      latest: snapshot({
        exploitClasses: ['TW-03-credit-burn-no-value', 'TW-04-approval-bypass'],
      }),
      previous: snapshot({
        id: 'run-prev',
        exploitClasses: ['TW-03-credit-burn-no-value'],
      }),
      now: NOW,
    });
    // §CORRECTION 7: findings are advisory and remediation is a separate
    // human-authored commit. If someone ever wires a remedy in here, the
    // copy is the first thing that will start lying.
    for (const alert of alerts) {
      expect(alert.detail.toLowerCase()).not.toMatch(
        /automatically (applied|remediated|fixed)/
      );
    }
    expect(alerts[0].detail).toContain('Nothing has been changed');
  });
});

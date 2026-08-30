/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * §3.5 item 4: "Prove ingest end to end. A scheduled run must land a real row
 * in `simulation_runs` with a real report. Verify `SIMULATION_INGEST_SECRET`
 * is set and that an unauthenticated ingest is rejected."
 *
 * The path this file covers had three independent breaks, and each of them
 * left the surface looking finished:
 *
 *   - The engine never POSTed anything, so simulation_runs stayed empty while
 *     report JSON accumulated on whichever machine ran it.
 *   - index.ts imported `simulationRoutes` and never mounted it, so the admin
 *     read routes 404'd.
 *   - Those handlers gated on `c.get('isAdmin')`, which nothing in this
 *     codebase sets, so even once mounted they would 403 a full admin.
 *
 * None of the three is visible from a unit test: the first needs the real
 * route, the second needs the real mount order, and the third needs the real
 * auth middleware and a real `users` row. So this runs the whole thing —
 * migrations applied, Worker booted, requests through `exports.default.fetch`.
 *
 * The payload below is the shape `to_ingest_payload` in
 * simulation/monte_carlo_engine.py builds. If that function's key names drift
 * from these, the route binds `undefined` and stores NULL without failing —
 * which is exactly how vdr_percent stayed empty — so keep the two in step.
 */
import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { sha256Hex } from '../../src/lib/virtual-key.js';
import { handleSimulationWatchdog } from '../../src/lib/cron-handler.js';

const SECRET = 'test-simulation-secret';
const ADMIN_KEY = 'test-virtual-key-sim-admin';
const PLAIN_KEY = 'test-virtual-key-sim-plain';

const REPORT = {
  runType: 'monte_carlo',
  numBots: 12,
  totalCreditsSimulated: 96,
  vdrPercent: 71.5,
  houseEdgePercent: 28.5,
  exploitsFound: [
    {
      bot: 'credit-burner-3',
      pattern: 'credit_burner',
      tripwires: ['TW-03-credit-burn-no-value:22 credits, no files'],
      credits_burned: 22,
    },
  ],
  tripwireBreakdown: { 'TW-03-credit-burn-no-value': 4 },
  recommendations: ['Add early-exit: 15+ credits with no files generated'],
  rawReport: {
    credit_status: {
      total_budget: 120,
      spent: 96,
      remaining: 24,
      paused: false,
    },
  },
};

function ingest(body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request('http://example.com/api/simulation/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
}

function get(path: string, key: string) {
  return exports.default.fetch(
    new Request(`http://example.com${path}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
  );
}

beforeAll(async () => {
  const now = new Date().toISOString();
  const users: Array<[string, string, string, string | null]> = [
    ['user-sim-admin', 'sim-admin@example.com', ADMIN_KEY, '-full'],
    ['user-sim-plain', 'sim-plain@example.com', PLAIN_KEY, null],
  ];
  for (const [id, email, rawKey, adminLevel] of users) {
    await env.DB.prepare(
      `INSERT INTO users (id, email, virtual_key, tier, credits_remaining, admin_level, created_date, updated_date)
       VALUES (?, ?, ?, 'pro', 1000, ?, ?, ?)`
    )
      .bind(id, email, await sha256Hex(rawKey), adminLevel, now, now)
      .run();
  }
});

describe('the ingest endpoint', () => {
  it('rejects a POST with no secret', async () => {
    const res = await ingest(REPORT);
    expect(res.status).toBe(401);
  });

  it('rejects a POST with the wrong secret', async () => {
    const res = await ingest(REPORT, { 'X-Simulation-Secret': 'nope' });
    expect(res.status).toBe(401);
  });

  it('rejects a session instead of the secret', async () => {
    // The engine has no user. A caller holding a valid virtual key is still
    // not the engine, and this route is mounted before requireAuth — so the
    // one thing standing between the internet and simulation_runs is the
    // secret comparison.
    const res = await ingest(REPORT, { Authorization: `Bearer ${ADMIN_KEY}` });
    expect(res.status).toBe(401);
  });

  it('stores a real row when the secret matches', async () => {
    const res = await ingest(REPORT, { 'X-Simulation-Secret': SECRET });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const row = await env.DB.prepare(
      `SELECT * FROM simulation_runs WHERE id = ?`
    )
      .bind(id)
      .first<Record<string, unknown>>();

    expect(row).toBeTruthy();
    expect(row!.num_bots).toBe(12);
    expect(row!.total_credits_simulated).toBe(96);
    // The two fields that were NULL on every row until the engine started
    // calling calculate_simulation_vdr.
    expect(row!.vdr_percent).toBe(71.5);
    expect(row!.house_edge_percent).toBe(28.5);
    expect(JSON.parse(row!.tripwire_breakdown_json as string)).toEqual({
      'TW-03-credit-burn-no-value': 4,
    });
    // The boundary, in the schema: an ingested run is unreviewed and unapplied.
    expect(row!.approved_by_admin).toBe(0);
    expect(row!.applied_to_architecture).toBe(0);
  });
});

describe('the admin read surface', () => {
  it('serves /latest to an admin', async () => {
    const res = await get('/api/simulation/latest', ADMIN_KEY);
    // Not 404: the router is mounted. Not 403: the gate is requireAdmin, not
    // a context variable nothing sets.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.numBots).toBe(12);
    expect(body.appliedToArchitecture).toBe(false);
    // §3.5 item 3 — the spend is visible, not inferred from a bill later.
    expect(body.creditStatus).toMatchObject({ total_budget: 120, spent: 96 });
  });

  it('refuses a signed-in non-admin', async () => {
    const res = await get('/api/simulation/latest', PLAIN_KEY);
    expect(res.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/simulation/latest')
    );
    expect(res.status).toBe(401);
  });

  it('serves /history and /alerts to an admin', async () => {
    const history = await get('/api/simulation/history', ADMIN_KEY);
    expect(history.status).toBe(200);
    expect(
      ((await history.json()) as { runs: unknown[] }).runs.length
    ).toBeGreaterThan(0);

    const alerts = await get('/api/simulation/alerts', ADMIN_KEY);
    expect(alerts.status).toBe(200);
    expect((await alerts.json()) as object).toHaveProperty('alerts');
  });
});

describe('the watchdog, against a seeded regression', () => {
  it('raises an alert a human can read, once, and changes nothing else', async () => {
    // A second run, later than the ingested one, carrying an exploit class
    // that was not in it. This is the seeded regression §3.5's acceptance
    // asks for.
    //
    // `+1 hour` rather than `now`: the ingest route stamps its own row with
    // `datetime('now')` at second granularity, so a row seeded in the same
    // second sorts arbitrarily against it and the test would pick whichever
    // run SQLite happened to return first. Real runs are a day apart, so this
    // is a property of the test's clock and not of the watchdog.
    await env.DB.prepare(
      `INSERT INTO simulation_runs (
         id, run_type, status, num_bots, total_credits_simulated,
         vdr_percent, house_edge_percent, exploits_found_json,
         tripwire_breakdown_json, recommendations_json, raw_report_json,
         approved_by_admin, applied_to_architecture, created_date, created_by
       ) VALUES ('run-regression', 'monte_carlo', 'completed', 12, 110,
         60.0, 40.0, ?, ?, '[]', '{}', 0, 0,
         datetime('now', '+1 hour'), 'test')`
    )
      .bind(
        JSON.stringify([
          { bot: 'x', tripwires: ['TW-04-approval-bypass:gate skipped'] },
        ]),
        JSON.stringify({ 'TW-04-approval-bypass': 5 })
      )
      .run();

    await handleSimulationWatchdog(env as never);

    const alerts = await env.DB.prepare(
      `SELECT kind, severity, run_id, dedupe_key FROM simulation_alerts`
    ).all<Record<string, unknown>>();

    const kinds = (alerts.results ?? []).map((a) => a.kind);
    expect(kinds).toContain('new_exploit_class');
    // The class, not the class plus the detail after the colon — otherwise
    // every night's hits look new and the alert becomes noise.
    const row = (alerts.results ?? []).find(
      (a) => a.kind === 'new_exploit_class'
    );
    expect(row!.severity).toBe('high');
    expect(row!.run_id).toBe('run-regression');

    // Idempotent: the cron reads the same two rows every morning until a new
    // report lands. Running it twice must not raise the same alert twice.
    const before = (alerts.results ?? []).length;
    await handleSimulationWatchdog(env as never);
    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM simulation_alerts`
    ).first<{ n: number }>();
    expect(after!.n).toBe(before);

    // The boundary holds: the watchdog wrote alerts and nothing else.
    const untouched = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM simulation_runs
       WHERE applied_to_architecture != 0 OR approved_by_admin != 0`
    ).first<{ n: number }>();
    expect(untouched!.n).toBe(0);
  });

  it('surfaces those alerts on the admin route', async () => {
    const res = await get('/api/simulation/alerts', ADMIN_KEY);
    const body = (await res.json()) as {
      alerts: { kind: string; acknowledged: boolean; id: string }[];
      unacknowledged: number;
    };
    expect(body.unacknowledged).toBeGreaterThan(0);

    const target = body.alerts.find((a) => a.kind === 'new_exploit_class');
    const ack = await exports.default.fetch(
      new Request(
        `http://example.com/api/simulation/alerts/${target!.id}/acknowledge`,
        { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_KEY}` } }
      )
    );
    expect(ack.status).toBe(200);

    const after = await get('/api/simulation/alerts', ADMIN_KEY);
    const afterBody = (await after.json()) as { unacknowledged: number };
    expect(afterBody.unacknowledged).toBe(body.unacknowledged - 1);
  });
});

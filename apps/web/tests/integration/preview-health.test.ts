/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * The Tier 3 control plane, against the real Worker and the real Sandbox DO.
 *
 * Two things are pinned here, and both are invisible to a unit test because
 * neither is a wrong function — each is a wrong *address*.
 *
 * 1. **Control endpoints and the generated app no longer share a namespace.**
 *    `Sandbox.fetch` used to match `/start`, `/status`, `/destroy`, `/scan` and
 *    `/logs` by pathname and proxy everything else. `/status` and `/health` are
 *    two of the most common routes a generated API defines, so a founder whose
 *    app served `/status` had that route answered by this platform's container
 *    internals instead. Adding `/health` for the health check would have made
 *    it three. The split is by origin now (SANDBOX_CONTROL_ORIGIN), and the
 *    proxy path is built from a URL pathname — so no generated route can reach
 *    the control plane whatever it is called.
 *
 * 2. **A control call that matches nothing 404s rather than being proxied.**
 *    The admin panel's "kill sandbox" sent `POST /destroy`; the DO only ever
 *    handled `DELETE /destroy`. The POST fell through to the proxy, was
 *    forwarded to the generated app, and the failure was swallowed by the
 *    caller's `.catch(() => undefined)` — so the control logged a kill and
 *    reported success while destroying nothing.
 *
 * No container runs in Miniflare, which is exactly why these are checkable
 * here: the two planes give *different* answers with no container (the proxy
 * says "not running", the control plane answers about itself), so which plane
 * handled a request is observable.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { SANDBOX_CONTROL_ORIGIN } from '../../src/durable-objects/sandbox-preview.js';

const PROJECT_ID = 'project-preview-health';

function sandbox() {
  return env.PREVIEW_SANDBOX.get(env.PREVIEW_SANDBOX.idFromName(PROJECT_ID));
}

/** How the proxy answers when there is no container behind it. Distinct from
 * every control-plane response, which is what makes the plane observable. */
const NOT_RUNNING = 'Sandbox not running';

describe('the sandbox control plane is addressed separately from the app', () => {
  beforeAll(() => {
    // Nothing to seed: these talk to the DO directly, below the ownership
    // check that routes/preview.ts enforces (covered in
    // preview-addressing.test.ts).
  });

  for (const path of ['/status', '/health', '/start', '/logs', '/destroy']) {
    it(`proxies a generated app's ${path} to the app, not to the control plane`, async () => {
      const res = await sandbox().fetch(`https://sandbox${path}`);
      // The proxy's answer, because there is no container. Before the origin
      // split this returned the DO's own JSON for /status and /health, and
      // would have answered the founder's route with our internals.
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(NOT_RUNNING);
    });
  }

  it('answers the control plane on the control origin', async () => {
    const res = await sandbox().fetch(`${SANDBOX_CONTROL_ORIGIN}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      running: boolean;
      devServerStarted: boolean;
      backendRunning: boolean;
      phase: string;
    };
    expect(body.running).toBe(false);
    expect(body.phase).toBe('booting');
  });

  it('404s a control call that matches nothing, instead of proxying it', async () => {
    // The admin panel's exact former mistake: the right path, the wrong method.
    const res = await sandbox().fetch(`${SANDBOX_CONTROL_ORIGIN}/destroy`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('POST /destroy'),
    });
  });
});

describe('the health check reports what it could not check', () => {
  it('calls nothing healthy when there is no container', async () => {
    const res = await sandbox().fetch(`${SANDBOX_CONTROL_ORIGIN}/health`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      healthy: boolean;
      degraded: boolean;
      probes: Array<{ target: string; outcome: string; detail: string }>;
    };

    // Neither healthy nor degraded. "The probe did not run" is its own state:
    // reporting it as healthy would launder an unchecked preview into a green
    // banner, and reporting it as degraded would alarm every founder whose
    // container is still booting.
    expect(report.healthy).toBe(false);
    expect(report.degraded).toBe(false);
    expect(report.probes.map((p) => p.outcome)).toEqual([
      'unprobeable',
      'unprobeable',
    ]);
    // Every probe carries a reason. A blank detail is how a check that never
    // ran becomes indistinguishable from one that passed.
    for (const probe of report.probes) {
      expect(probe.detail.length).toBeGreaterThan(0);
    }
  });
});

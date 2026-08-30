/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * The SSE stream is the only thing that tells the browser what stage a run is
 * on, so §3.4's "make pipeline state legible" is downstream of these frames
 * being right. Two of them are pinned here.
 *
 * `step:start` for the Coder used to be sent with a hard-coded `step: 4`
 * while the Coder's `pipeline_steps` rows are written with `step_number` 5.
 * The client derives the agent from the number and ignores the `agent` field
 * sent beside it, so for the entire build the UI believed the Designer was
 * still working. Nothing errored; it described the wrong stage, for the
 * longest stage of the run.
 *
 * A unit test could not have caught it. The number is only wrong relative to
 * what the orchestrator wrote, so the check has to see both — which is what
 * this file does: real migrations, real rows in the shapes
 * `GenerationOrchestrator.startStep` writes them, real auth middleware, real
 * route.
 *
 * The run is seeded rather than generated for the same reason as
 * pipeline-verboseness.test.ts: five model round trips are not what is under
 * test. It is seeded `deployed` so the route's poll loop hits a terminal
 * status and closes on its first pass instead of holding the stream open.
 */
import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { sha256Hex } from '../../src/lib/virtual-key.js';

const RAW_KEY = 'test-virtual-key-stream';
const USER_ID = 'user-stream';
const RUN_ID = 'run-stream';
const PROJECT_ID = 'project-stream';
const STARTED_AT = '2026-08-30T09:00:00.000Z';

interface Frame {
  type: string;
  step?: number;
  agent?: string;
  model?: string;
  projectId?: string | null;
  startedAt?: string | null;
}

/** Reads the whole stream to close and parses every `data:` line. Safe only
 * because the run is seeded terminal; a running one would never end. */
async function frames(): Promise<Frame[]> {
  const res = await exports.default.fetch(
    new Request(`http://example.com/api/pipeline/${RUN_ID}`, {
      headers: { Authorization: `Bearer ${RAW_KEY}` },
    })
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Frame);
}

beforeAll(async () => {
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (id, email, virtual_key, tier, credits_remaining, created_date, updated_date)
     VALUES (?, ?, ?, 'pro', 1000, ?, ?)`
  )
    .bind(USER_ID, 'stream@example.com', await sha256Hex(RAW_KEY), now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO pipeline_runs (id, user_id, project_id, prompt, status, execution_mode, started_at, created_date, updated_date, created_by)
     VALUES (?, ?, ?, 'build me a todo app', 'deployed', 'ask_first', ?, ?, ?, ?)`
  )
    .bind(RUN_ID, USER_ID, PROJECT_ID, STARTED_AT, now, now, USER_ID)
    .run();

  // The step numbers the orchestrator actually writes. Coder is 5, and that
  // is the whole point of this file.
  const steps: Array<[number, string, string]> = [
    [1, 'researcher', 'command-a-03-2025'],
    [2, 'auditor', 'nvidia/nemotron-3-super-120b-a12b'],
    [3, 'verifier', 'command-a-03-2025'],
    [4, 'designer', 'command-a-03-2025'],
  ];
  for (const [number, role, model] of steps) {
    await env.DB.prepare(
      `INSERT INTO pipeline_steps (id, pipeline_run_id, step_number, agent_role, model_used, status, iteration, started_at, created_date, created_by)
       VALUES (?, ?, ?, ?, ?, 'completed', 1, ?, ?, 'system')`
    )
      .bind(`step-${number}`, RUN_ID, number, role, model, now, now)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO pipeline_steps (id, pipeline_run_id, step_number, agent_role, model_used, status, iteration, started_at, created_date, created_by)
     VALUES (?, ?, 5, 'coder', 'command-a-03-2025', 'running', 1, ?, ?, 'system')`
  )
    .bind('step-5', RUN_ID, now, now)
    .run();
});

describe('the stream describes the stage the run is actually on', () => {
  it('announces the Coder with the step number its rows were written with', async () => {
    const start = (await frames()).find(
      (f) => f.type === 'step:start' && f.agent === 'coder'
    );
    expect(start).toBeDefined();
    // 5, not 4. `STEP_AGENTS[step - 1]` in usePipeline is what turns this
    // number into the name on screen, so a 4 here renders "Designer".
    expect(start?.step).toBe(5);
  });

  it('agrees with the client about which agent each number means', async () => {
    // The reducer maps number → agent and drops the `agent` field. If the two
    // ever disagree the UI silently follows the number, so assert they never
    // do — for every frame, not just the Coder's.
    const order = ['researcher', 'auditor', 'verifier', 'designer', 'coder'];
    for (const frame of await frames()) {
      if (frame.step === undefined || frame.agent === undefined) continue;
      expect(order[frame.step - 1]).toBe(frame.agent);
    }
  });

  it('opens with the run’s real start time, not the moment of connection', async () => {
    // The elapsed clock in the header reads this. Without it a reload of a
    // four-minute-old run displays "0s" — which is not a missing number, it
    // is a wrong one.
    const context = (await frames()).find((f) => f.type === 'pipeline:context');
    expect(context?.startedAt).toBe(STARTED_AT);
    expect(context?.projectId).toBe(PROJECT_ID);
  });

  it('names the model that served each step', async () => {
    // §3.4 asks the header to show which model. It can only show what the
    // stream sends, and `model_used` has always been on the row.
    const auditor = (await frames()).find(
      (f) => f.type === 'step:complete' && f.agent === 'auditor'
    );
    expect(auditor?.model).toBe('nvidia/nemotron-3-super-120b-a12b');
  });
});

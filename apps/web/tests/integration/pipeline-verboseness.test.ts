/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * §3.3's acceptance criterion, against the real Worker and a real D1.
 *
 * "A test drives a generation at each level and asserts the transcript
 * contains exactly what that level promises, and no more."
 *
 * The run is seeded rather than generated — a real generation needs a Cohere
 * key and five model round trips, neither of which belongs in a test that is
 * about a projection. What is real here is everything the projection depends
 * on: the migrated schema, the auth middleware, the route, and the rows in the
 * shapes the orchestrator writes them. The *promise* each level makes is
 * pinned separately, in src/lib/verboseness.test.ts.
 *
 * The assertion that matters most is the third one down: reading the same
 * completed run at a higher level returns the rows the lower level withheld.
 * That is §3.3's "raising verbosity mid-run reveals what already happened; it
 * does not require a re-run", and it is a property of the endpoint re-reading
 * the whole history every time rather than of any replay machinery.
 */
import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { sha256Hex } from '../../src/lib/virtual-key.js';
import { REDACTED } from '../../src/lib/verboseness.js';

const RAW_KEY = 'test-virtual-key-verboseness';
const USER_ID = 'user-verboseness';
const RUN_ID = 'run-verboseness';

/** A credential-shaped value planted in agent metadata. Nothing in the
 * pipeline puts one there today; this is the check that keeps it that way,
 * because verbose is the setting that would carry it to a browser. */
const PLANTED_SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef';

interface TranscriptStage {
  step: number;
  agent: string;
  status: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number | null;
}

interface TranscriptMessage {
  id: string;
  step: string;
  messageType: string;
  content: string;
  metadata: unknown;
}

interface Transcript {
  verboseness: string;
  stages: TranscriptStage[];
  messages: TranscriptMessage[];
}

async function transcript(level?: string): Promise<Transcript> {
  const url = new URL(`http://example.com/api/pipeline/${RUN_ID}/messages`);
  if (level) url.searchParams.set('verboseness', level);
  const res = await exports.default.fetch(
    new Request(url, { headers: { Authorization: `Bearer ${RAW_KEY}` } })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Transcript;
}

function kinds(t: Transcript): string[] {
  return [...new Set(t.messages.map((m) => m.messageType))].sort();
}

beforeAll(async () => {
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (id, email, virtual_key, tier, credits_remaining, created_date, updated_date)
     VALUES (?, ?, ?, 'pro', 1000, ?, ?)`
  )
    .bind(
      USER_ID,
      'verboseness@example.com',
      await sha256Hex(RAW_KEY),
      now,
      now
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO pipeline_runs (id, user_id, prompt, status, current_step, started_at, created_date, updated_date)
     VALUES (?, ?, 'a todo app', 'deployed', 5, ?, ?, ?)`
  )
    .bind(RUN_ID, USER_ID, now, now, now)
    .run();

  // Two steps, on deliberately different models: the researcher on the Cohere
  // workhorse and the auditor on the pinned independent model. Verbose mode is
  // how a founder sees that difference, so the fixture has to contain one.
  const steps: Array<[string, number, string, string, number, number, number]> =
    [
      [
        'step-researcher',
        1,
        'researcher',
        'command-a-03-2025',
        1200,
        800,
        4300,
      ],
      [
        'step-auditor',
        2,
        'auditor',
        'nvidia/nemotron-3-super-120b-a12b',
        900,
        400,
        2100,
      ],
    ];
  for (const [
    id,
    number,
    role,
    model,
    tokensIn,
    tokensOut,
    durationMs,
  ] of steps) {
    await env.DB.prepare(
      `INSERT INTO pipeline_steps (id, pipeline_run_id, step_number, agent_role, model_used,
                                   status, iteration, tokens_in, tokens_out, credits_used,
                                   duration_ms, started_at, created_date)
       VALUES (?, ?, ?, ?, ?, 'completed', 1, ?, ?, 3, ?, ?, ?)`
    )
      .bind(
        id,
        RUN_ID,
        number,
        role,
        model,
        tokensIn,
        tokensOut,
        durationMs,
        now,
        now
      )
      .run();
  }

  const messages: Array<[string, string, string, string, unknown]> = [
    [
      'm-reasoning',
      'researcher',
      'reasoning',
      'Starting research for: "a todo app"',
      null,
    ],
    [
      'm-tool',
      'researcher',
      'tool',
      'Searched the web for evidence — 4 results.',
      { tool: 'web-search', query: 'todo app' },
    ],
    [
      'm-output',
      'researcher',
      'output',
      'Research complete. 4 similar projects.',
      // The planted credential rides under an innocent key, which is the leak
      // a key-name list alone would not catch.
      { note: PLANTED_SECRET, apiKey: 'whatever', similarProjects: 4 },
    ],
    [
      'm-gate',
      'researcher',
      'gate',
      'Gate passed — advancing to Auditor.',
      null,
    ],
    ['m-error', 'auditor', 'error', 'Audit could not reach the model.', null],
  ];
  for (const [id, step, type, content, metadata] of messages) {
    await env.DB.prepare(
      `INSERT INTO agent_messages (id, pipeline_run_id, step, message_type, content, metadata, created_at, created_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        RUN_ID,
        step,
        type,
        content,
        metadata ? JSON.stringify(metadata) : null,
        now,
        now
      )
      .run();
  }
});

describe('a transcript at each level contains exactly what that level promises', () => {
  it('quiet: stage transitions and the result, and nothing else', async () => {
    const t = await transcript('quiet');
    expect(kinds(t)).toEqual(['error', 'gate']);
    // Said as an absence too, because "and no more" is half the criterion.
    expect(t.messages.map((m) => m.id)).not.toContain('m-output');
    expect(t.messages.map((m) => m.id)).not.toContain('m-reasoning');
  });

  it('normal: the above plus each agent conclusion, and still no reasoning', async () => {
    const t = await transcript('normal');
    expect(kinds(t)).toEqual(['error', 'gate', 'output']);
  });

  it('verbose: reasoning and tool invocations as well', async () => {
    const t = await transcript('verbose');
    expect(kinds(t)).toEqual(['error', 'gate', 'output', 'reasoning', 'tool']);
  });

  it('reveals what already happened when the level is raised, with no re-run', async () => {
    // Same run, same rows, no second generation — the level is a projection
    // over a record that was always complete.
    const quiet = await transcript('quiet');
    const verbose = await transcript('verbose');
    expect(verbose.messages.length).toBeGreaterThan(quiet.messages.length);
    expect(verbose.messages.map((m) => m.id)).toEqual(
      expect.arrayContaining(quiet.messages.map((m) => m.id))
    );
    expect(verbose.messages.map((m) => m.id)).toContain('m-reasoning');
  });
});

describe('stage status is not a verboseness decision', () => {
  it.each(['quiet', 'normal', 'verbose'])(
    'reports every stage and its status at %s',
    async (level) => {
      // The panel derives each agent's status from this. If it narrowed with
      // the level, a quiet run would look permanently stuck — a display
      // setting changing what the pipeline appears to have done.
      const t = await transcript(level);
      expect(t.stages.map((s) => s.agent)).toEqual(['researcher', 'auditor']);
      expect(t.stages.every((s) => s.status === 'completed')).toBe(true);
    }
  );

  it.each(['quiet', 'normal'])(
    'withholds the model id and token counts at %s',
    async (level) => {
      const t = await transcript(level);
      for (const stage of t.stages) {
        expect(stage.model).toBeUndefined();
        expect(stage.tokensIn).toBeUndefined();
      }
    }
  );

  it('shows which model served each step at verbose', async () => {
    // After CORRECTION 2 this is the founder's only way to see that the
    // auditor is genuinely a different model from the work it grades.
    const t = await transcript('verbose');
    const byAgent = Object.fromEntries(t.stages.map((s) => [s.agent, s]));
    expect(byAgent.researcher.model).toBe('command-a-03-2025');
    expect(byAgent.auditor.model).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(byAgent.auditor.model).not.toBe(byAgent.researcher.model);
    expect(byAgent.researcher.tokensIn).toBe(1200);
    expect(byAgent.researcher.tokensOut).toBe(800);
    expect(byAgent.researcher.durationMs).toBe(4300);
  });
});

describe('the verbose stream carries no credential', () => {
  it('redacts a credential-shaped value planted in agent metadata', async () => {
    const t = await transcript('verbose');
    const output = t.messages.find((m) => m.id === 'm-output');
    const metadata = output?.metadata as Record<string, unknown>;
    expect(metadata.note).toBe(REDACTED);
    expect(metadata.apiKey).toBe(REDACTED);
    // Redaction is not deletion: the shape survives so a hole is visible.
    expect(metadata.similarProjects).toBe(4);
  });

  it('leaves no trace of the secret anywhere in the response body', async () => {
    // The per-field assertion above would pass if the value were also copied
    // somewhere else in the payload. This one would not.
    const url = new URL(
      `http://example.com/api/pipeline/${RUN_ID}/messages?verboseness=verbose`
    );
    const res = await exports.default.fetch(
      new Request(url, { headers: { Authorization: `Bearer ${RAW_KEY}` } })
    );
    expect(await res.text()).not.toContain(PLANTED_SECRET);
  });
});

describe('the stored setting', () => {
  it('is used when the request names no level', async () => {
    // No row exists for this user yet, so this is the default rather than a
    // stored choice — which is itself the behaviour under test.
    expect((await transcript()).verboseness).toBe('normal');
  });

  it('persists a chosen level and is applied to a later transcript', async () => {
    const saved = await exports.default.fetch(
      new Request('http://example.com/api/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${RAW_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ verboseness: 'verbose' }),
      })
    );
    expect(saved.status).toBe(200);

    const t = await transcript();
    expect(t.verboseness).toBe('verbose');
    expect(kinds(t)).toContain('reasoning');
  });

  it('refuses an unknown level rather than quietly storing the default', async () => {
    // A UI that thinks it saved a setting it did not is a harder bug to see
    // than a 400.
    const res = await exports.default.fetch(
      new Request('http://example.com/api/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${RAW_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ verboseness: 'chatty' }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('falls back to a defined level if the column holds something unknown', async () => {
    // The column is unconstrained TEXT, exactly like execution_mode, and this
    // is the write that no route would make but a hand-run UPDATE or an older
    // build would.
    await env.DB.prepare(
      'UPDATE user_settings SET verboseness = ? WHERE user_id = ?'
    )
      .bind('dangerously_verbose', USER_ID)
      .run();
    expect((await transcript()).verboseness).toBe('normal');
  });
});

/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * The conversation turn limit on POST /api/pipeline, pinned against a real D1.
 *
 * This is an integration test rather than a unit test because both defects it
 * covers are invisible to a fake database, and one of them was *introduced* by
 * a fix that looked right:
 *
 *  1. The query bound `datetime(?, ?)` with ('-15 minutes', 'now'). SQLite's
 *     datetime() is (timevalue, modifier...), so the arguments were reversed,
 *     the expression returned NULL, `created_date > NULL` was NULL, and the
 *     limit had never fired once.
 *  2. Correcting only the order — to datetime('now','-15 minutes') — swaps that
 *     for the opposite failure. `created_date` is written with toISOString()
 *     ("...T03:33:23.704Z") while SQLite renders the bound as
 *     "... 06:18:23" — space separator, no zone. D1 compares TEXT
 *     lexicographically and 'T' (0x54) sorts above ' ' (0x20), so every row
 *     from the same calendar day counts as "within the last 15 minutes".
 *
 * A mock returning a canned count reports both as passing, which is the point:
 * the bug lives in how two string formats compare, so the test has to use the
 * engine that compares them. Same reasoning as chat-quota.test.ts, one layer
 * further down.
 *
 * The third assertion is about ordering rather than counting — an over-limit
 * caller must not be charged — and needs the real route, because the charge and
 * the refusal are in different statements of the same handler.
 */
import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { sha256Hex } from '../../src/lib/virtual-key.js';
import { SIM_EVOLVED } from '@bicameral/shared/constants';

const RAW_KEY = 'test-virtual-key-turn-limit';
const USER_ID = 'user-turn-limit';
const START_CREDITS = 100_000;

/** Seeds `count` runs whose created_date is `minutesAgo` in the past, in the
 *  exact format the route writes: toISOString(). */
async function seedRuns(count: number, minutesAgo: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO pipeline_runs (id, user_id, project_id, prompt, status, execution_mode, started_at, created_date, updated_date, created_by)
       VALUES (?, ?, 'p-turn-limit', 'seeded', 'deployed', 'ask_first', ?, ?, ?, ?)`
    )
      .bind(`run-tl-${minutesAgo}-${i}`, USER_ID, at, at, at, USER_ID)
      .run();
  }
}

async function credits(): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT credits_remaining FROM users WHERE id = ?'
  )
    .bind(USER_ID)
    .first<{ credits_remaining: number }>();
  return row?.credits_remaining ?? -1;
}

async function startRun(): Promise<Response> {
  return exports.default.fetch(
    new Request('http://example.com/api/pipeline', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RAW_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'build me a todo app' }),
    })
  );
}

/** The 5-in-1 entry point. Same handler, execution mode pinned. */
async function startUnifiedRun(): Promise<Response> {
  return exports.default.fetch(
    new Request('http://example.com/api/pipeline/unified', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RAW_KEY}`,
        'Content-Type': 'application/json',
      },
      // `ask_first` is sent deliberately: the route must override what the
      // client asked for, not merely default when nothing was asked.
      body: JSON.stringify({
        prompt: 'build me a todo app',
        executionMode: 'ask_first',
      }),
    })
  );
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM pipeline_runs WHERE user_id = ?')
    .bind(USER_ID)
    .run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(USER_ID).run();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, email, virtual_key, tier, credits_remaining, created_date, updated_date)
     VALUES (?, ?, ?, 'pro', ?, ?, ?)`
  )
    .bind(
      USER_ID,
      'turn-limit@example.com',
      await sha256Hex(RAW_KEY),
      START_CREDITS,
      now,
      now
    )
    .run();
});

describe('the conversation turn limit counts the right window', () => {
  it('refuses once the window is full', async () => {
    await seedRuns(SIM_EVOLVED.conversationTurnLimit, 1);
    const res = await startRun();
    expect(res.status).toBe(429);
    const body = await res.json<{
      error: string;
      retry_after_seconds: number;
    }>();
    expect(body.error).toBe('Conversation turn limit reached');
    expect(body.retry_after_seconds).toBe(900);
  });

  it('ignores runs that are older than the window but on the same day', async () => {
    // THE REGRESSION GUARD. These rows are three hours old, so they are far
    // outside a 15-minute window — but their ISO strings sort ABOVE a
    // SQLite-rendered bound for the same date. If the query ever goes back to
    // comparing against datetime('now','-15 minutes'), this is the assertion
    // that fails, and it fails for every founder every day rather than rarely.
    await seedRuns(SIM_EVOLVED.conversationTurnLimit * 2, 180);
    const res = await startRun();
    expect(res.status).toBe(201);
  });

  it('never charges a caller it is about to refuse', async () => {
    // The check used to run after debitCredits, after the pipeline_runs
    // insert, and after waitUntil(kickOffOrchestrator) — so a 429 arrived
    // having already taken the money and started the work.
    await seedRuns(SIM_EVOLVED.conversationTurnLimit, 1);
    const before = await credits();
    const res = await startRun();
    expect(res.status).toBe(429);
    expect(await credits()).toBe(before);

    // And no run row was written for the refused request. Seeded rows have
    // ids prefixed `run-tl-`; anything else is one the route created.
    const created = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM pipeline_runs WHERE user_id = ? AND id NOT LIKE 'run-tl-%'"
    )
      .bind(USER_ID)
      .first<{ count: number }>();
    expect(created?.count).toBe(0);
  });
});

describe('the unified 5-in-1 entry point', () => {
  it('pins auto_accept even when the client asks for ask_first', async () => {
    const res = await startUnifiedRun();
    expect(res.status).toBe(201);
    const body = await res.json<{
      pipelineId: string;
      executionMode: string;
    }>();
    expect(body.executionMode).toBe('auto_accept');
    // And it is what was actually persisted, not just what was reported — the
    // orchestrator reads the column, never the response.
    const row = await env.DB.prepare(
      'SELECT execution_mode FROM pipeline_runs WHERE id = ?'
    )
      .bind(body.pipelineId)
      .first<{ execution_mode: string }>();
    expect(row?.execution_mode).toBe('auto_accept');
  });

  it('leaves POST / defaulting to ask_first', async () => {
    // The constraint that makes the route above safe to add: the existing
    // entry point's default is unchanged, so no current client silently starts
    // auto-advancing through its inter-agent gates.
    const res = await startRun();
    expect(res.status).toBe(201);
    const body = await res.json<{ pipelineId: string }>();
    const row = await env.DB.prepare(
      'SELECT execution_mode FROM pipeline_runs WHERE id = ?'
    )
      .bind(body.pipelineId)
      .first<{ execution_mode: string }>();
    expect(row?.execution_mode).toBe('ask_first');
  });

  it('is subject to the same turn limit, before charging', async () => {
    await seedRuns(SIM_EVOLVED.conversationTurnLimit, 1);
    const before = await credits();
    const res = await startUnifiedRun();
    expect(res.status).toBe(429);
    expect(await credits()).toBe(before);
  });
});

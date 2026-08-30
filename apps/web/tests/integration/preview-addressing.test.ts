/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Pins the chain that made Tier 3 unreachable.
 *
 * The full-stack preview is addressed by project: `POST /api/preview/:projectId`
 * resolves the container with `PREVIEW_SANDBOX.idFromName(projectId)`, checks
 * ownership against `projects`, and finds the blueprint whose `apiRoutes` the
 * sandbox serves by joining `pipeline_runs` on `project_id`. `project_id` is
 * nullable, and the Generation view sent nothing — so every run started from
 * the product's main entry point had a null one and there was nothing to key a
 * preview on. Nothing failed; the preview simply did not exist.
 *
 * That is invisible to a unit test, because no single function was wrong. It
 * only shows up end to end: the POST, the row it writes, and the SSE stream the
 * client recovers from after a reload. So this runs against the real Worker in
 * Miniflare, against a real D1 with the real migrations applied.
 */
import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { sha256Hex } from '../../src/lib/virtual-key.js';

const RAW_KEY = 'bk_preview_addressing_integration_key';
const USER_ID = 'user-preview-addressing';
const OTHER_USER_ID = 'user-preview-addressing-other';

async function seedUser(id: string, email: string, rawKey: string | null) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO users
       (id, email, full_name, role, tier, virtual_key, credits_remaining,
        credits_used, is_banned, created_date, updated_date, created_by)
     VALUES (?, ?, ?, 'user', 'pro', ?, 100000, 0, 0, ?, ?, ?)`
  )
    .bind(
      id,
      email,
      'Integration User',
      rawKey ? await sha256Hex(rawKey) : null,
      now,
      now,
      id
    )
    .run();
}

function authed(path: string, init: RequestInit = {}) {
  return exports.default.fetch(
    new Request(`http://example.com${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${RAW_KEY}`,
      },
    })
  );
}

/**
 * Read SSE frames until `count` have arrived, then cancel.
 *
 * The pipeline stream polls D1 for minutes; reading it to completion would
 * hang the suite. Cancelling after the frames under test is the point — the
 * invariant is specifically about what arrives *first*, because the client
 * needs the project id before it can ask for a container, and a container
 * start is the slow step.
 */
async function readFrames(res: Response, count: number): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: unknown[] = [];
  let buffered = '';
  try {
    while (frames.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split('\n\n');
      buffered = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return frames;
        frames.push(JSON.parse(data));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

describe('a pipeline run is always addressable as a project', () => {
  beforeAll(async () => {
    await seedUser(USER_ID, 'preview-addressing@example.com', RAW_KEY);
    await seedUser(OTHER_USER_ID, 'preview-other@example.com', null);
  });

  it('creates a project for a run that names none, and returns its id', async () => {
    const res = await authed('/api/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'A todo API with a /api/todos route\nand a React front end',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      pipelineId: string;
      projectId: string;
    };
    expect(body.projectId).toBeTruthy();

    // The row, not just the response: the response could be right while the
    // column stayed null, and the column is what the preview joins on.
    const run = await env.DB.prepare(
      'SELECT project_id FROM pipeline_runs WHERE id = ?'
    )
      .bind(body.pipelineId)
      .first<{ project_id: string | null }>();
    expect(run?.project_id).toBe(body.projectId);

    const project = await env.DB.prepare(
      'SELECT user_id, name FROM projects WHERE id = ?'
    )
      .bind(body.projectId)
      .first<{ user_id: string; name: string }>();
    expect(project?.user_id).toBe(USER_ID);
    // Named from the prompt's first line so the founder recognises the row in
    // Projects without opening it.
    expect(project?.name).toBe('A todo API with a /api/todos route');
  });

  it('sends the project id as the first frame of the run stream', async () => {
    const start = await authed('/api/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'A note-taking app' }),
    });
    const { pipelineId, projectId } = (await start.json()) as {
      pipelineId: string;
      projectId: string;
    };

    const stream = await authed(`/api/pipeline/${pipelineId}`);
    expect(stream.status).toBe(200);
    const [first] = (await readFrames(stream, 1)) as Array<{
      type: string;
      projectId?: string;
    }>;
    expect(first.type).toBe('pipeline:context');
    expect(first.projectId).toBe(projectId);
  });

  it('refuses a run against a project the caller does not own', async () => {
    const now = new Date().toISOString();
    const foreignProject = 'project-owned-by-someone-else';
    await env.DB.prepare(
      `INSERT OR REPLACE INTO projects
         (id, user_id, name, status, created_date, updated_date, created_by)
       VALUES (?, ?, 'Not yours', 'active', ?, ?, ?)`
    )
      .bind(foreignProject, OTHER_USER_ID, now, now, OTHER_USER_ID)
      .run();

    const res = await authed('/api/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Anything',
        projectId: foreignProject,
      }),
    });
    expect(res.status).toBe(404);
  });

  it('refuses a preview against a project the caller does not own', async () => {
    // One project's container must never be reachable from another account.
    // The ownership check has to reject before any container is addressed, so
    // this asserts 404 rather than an error out of the sandbox.
    const res = await authed('/api/preview/project-owned-by-someone-else');
    expect(res.status).toBe(404);
  });
});

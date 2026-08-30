/**
 * Preview — Tier 3 sandbox lifecycle. See @agent_docs/api-spec.md
 * "Preview" and durable-objects/Sandbox.ts. One Sandbox DO per project
 * (`idFromName(projectId)`); this route layer owns ownership checks and
 * forwards everything else straight to the DO's `fetch()`.
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';
import type { ProjectFile } from '@bicameral/shared/types';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { SANDBOX_CONTROL_ORIGIN } from '../durable-objects/sandbox-preview.js';
import type { HealthReport } from '../durable-objects/sandbox-health.js';

export const previewRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

async function assertProjectOwner(
  db: D1Database,
  projectId: string,
  userId: string
): Promise<void> {
  const project = await db
    .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
    .bind(projectId, userId)
    .first<{ id: string }>();
  if (!project)
    throw new BicameralError('Project not found', 'PROJECT_NOT_FOUND', 404);
}

function sandboxStub(env: Env, projectId: string) {
  return env.PREVIEW_SANDBOX.get(env.PREVIEW_SANDBOX.idFromName(projectId));
}

/**
 * One global admission registry — see durable-objects/PreviewCapacity.ts for
 * why it is deliberately not sharded.
 */
function capacityStub(env: Env) {
  return env.PREVIEW_CAPACITY.get(env.PREVIEW_CAPACITY.idFromName('global'));
}

interface Admission {
  admitted: boolean;
  position?: number;
  queueLength?: number;
  active: number;
  capacity: number;
}

interface BlueprintPreviewFacts {
  /** Paths the Designer promised a server would answer. */
  apiRoutePaths: string[];
  /** Env var *names* the blueprint declares. Values are not stored anywhere. */
  declaredEnvVars: string[];
}

/**
 * The two things the Sandbox needs from the blueprint to run a backend.
 *
 * `Sandbox` cannot look these up itself — it holds no D1 binding and no
 * ownership context — so the route layer, which has already proved the caller
 * owns the project, reads them and passes them in. Without `apiRoutePaths` the
 * proxy has only the `/api/*` convention to route on, which misses every
 * blueprint whose routes live somewhere else.
 *
 * Returns empty lists rather than throwing when there is no blueprint: a
 * frontend-only preview started before any pipeline run is a legitimate case,
 * and it needs no backend.
 */
async function blueprintPreviewFacts(
  db: D1Database,
  projectId: string
): Promise<BlueprintPreviewFacts> {
  const row = await db
    .prepare(
      `SELECT b.api_routes AS api_routes, b.env_vars AS env_vars
         FROM blueprints b
         JOIN pipeline_runs r ON r.id = b.pipeline_run_id
        WHERE r.project_id = ?
        ORDER BY b.created_date DESC
        LIMIT 1`
    )
    .bind(projectId)
    .first<{ api_routes: string | null; env_vars: string | null }>();

  if (!row) return { apiRoutePaths: [], declaredEnvVars: [] };

  return {
    apiRoutePaths: parseRoutePaths(row.api_routes),
    declaredEnvVars: parseStringList(row.env_vars),
  };
}

/**
 * `api_routes` is an unconstrained TEXT column holding whatever the Designer
 * emitted. Parsing defensively rather than casting, because a malformed value
 * here would otherwise throw inside the start path and present as "preview
 * failed to boot" for a reason nobody could find.
 */
function parseRoutePaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry && typeof entry === 'object' && 'path' in entry
          ? (entry as { path: unknown }).path
          : null
      )
      .filter(
        (path): path is string => typeof path === 'string' && path !== ''
      );
  } catch {
    return [];
  }
}

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

previewRoutes.post('/:projectId', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const body = await c.req.json<{ files: ProjectFile[] }>();
  if (!Array.isArray(body.files) || body.files.length === 0) {
    throw new BicameralError('files is required', 'VALIDATION_ERROR', 400);
  }

  // Ask for a slot before touching the container. `max_instances` is an
  // account-wide ceiling the platform enforces by refusing to start container
  // N+1 — so without this, the founder who happens to click Preview when the
  // pool is full gets a failure caused entirely by other people's sessions,
  // indistinguishable from their own app being broken. §3.2: queue visibly
  // rather than fail.
  const admission = await capacityStub(c.env)
    .fetch('https://capacity/admit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    })
    .then((r) => r.json<Admission>());

  if (!admission.admitted) {
    return c.json(
      {
        queued: true,
        position: admission.position,
        queueLength: admission.queueLength,
        active: admission.active,
        capacity: admission.capacity,
        // The client polls this endpoint; there is nothing to push to.
        retryAfterSeconds: 5,
      },
      202
    );
  }

  const facts = await blueprintPreviewFacts(c.env.DB, projectId);

  const response = await sandboxStub(c.env, projectId).fetch(
    `${SANDBOX_CONTROL_ORIGIN}/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: body.files,
        projectId,
        apiRoutePaths: facts.apiRoutePaths,
        declaredEnvVars: facts.declaredEnvVars,
        // No values: SystemBlueprint.envVars is a list of names, and nothing
        // in the platform stores a value for any of them. The Sandbox turns
        // each unfilled name into a visible warning rather than letting the
        // generated app read undefined in silence. When a value store exists,
        // it goes here — and buildContainerEnv (sandbox-backend.ts) already
        // refuses any value that matches a platform secret.
        envVars: {},
      }),
    }
  );

  // A slot held by a container that never started is a slot nobody can use
  // until its TTL expires, and it would push the next founder into a queue for
  // capacity that is actually free. Give it back on the spot.
  if (!response.ok) {
    await releaseSlot(c.env, projectId);
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});

async function releaseSlot(env: Env, projectId: string): Promise<void> {
  await capacityStub(env).fetch('https://capacity/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
}

previewRoutes.get('/:projectId', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const response = await sandboxStub(c.env, projectId).fetch(
    `${SANDBOX_CONTROL_ORIGIN}/status`
  );
  const status = await response.json<{
    running: boolean;
    devServerStarted: boolean;
    backendRunning: boolean;
    phase: string;
    warnings: string[];
  }>();

  // `degraded` is reported separately from `running` on purpose. A preview
  // whose backend never started still serves its frontend, so `running: true`
  // is accurate and, on its own, misleading — the UI needs to be able to say
  // "the app is up, its API is not" instead of showing a healthy preview whose
  // every fetch 503s.
  //
  // What it is derived FROM changed. It used to be `!status.backendRunning`,
  // and `backendRunning` is set the moment port 8080 accepts a connection — a
  // fact about a process, not about the app. A server that binds and then 500s
  // on every request, or serves none of the routes the blueprint declared, set
  // it true and the preview showed no banner at all. `/health` makes a real
  // HTTP request to a real declared route and judges the response; see
  // durable-objects/sandbox-health.ts.
  //
  // A probe that could not run (no declared routes, or every route
  // parameterised) reports `unprobeable` and does not set `degraded`. That is
  // not the same as a pass, and the probe's own `detail` line says which it was
  // rather than letting an unchecked preview read as a checked one.
  const expectsBackend =
    (await blueprintPreviewFacts(c.env.DB, projectId)).apiRoutePaths.length > 0;

  let health: HealthReport | null = null;
  if (status.running) {
    // Never allowed to fail the status call. A status endpoint that 500s
    // because its health probe threw tells the founder nothing at all, which
    // is strictly worse than telling them what the container reports.
    health = await sandboxStub(c.env, projectId)
      .fetch(`${SANDBOX_CONTROL_ORIGIN}/health`)
      .then((r) => (r.ok ? r.json<HealthReport>() : null))
      .catch(() => null);
  }

  // The status poll is also the heartbeat. An active slot is only kept alive by
  // somebody looking at it; a container whose founder closed the tab stops
  // being renewed and its slot returns to the pool after ACTIVE_SLOT_TTL_MS,
  // which is the backstop for the containers nothing ever reaped.
  if (status.running) {
    await capacityStub(c.env).fetch('https://capacity/renew', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
  }

  return c.json({
    ...status,
    degraded: status.running
      ? // Measured when the probe ran; otherwise the old process-liveness
        // signal, which is weaker but is what remains when the probe could not
        // be made. Falling back to `false` would turn an unreachable health
        // endpoint into a clean bill of health.
        (health?.degraded ?? (expectsBackend && !status.backendRunning))
      : false,
    health,
    previewUrl: status.running ? `/api/preview/${projectId}/proxy/` : null,
  });
});

previewRoutes.delete('/:projectId', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const response = await sandboxStub(c.env, projectId).fetch(
    `${SANDBOX_CONTROL_ORIGIN}/destroy`,
    { method: 'DELETE' }
  );
  // Released whether or not destroy reported success: a destroy that failed
  // leaves a container the idle timeout will collect, and holding the slot for
  // it would make one broken container cost every waiting founder.
  await releaseSlot(c.env, projectId);
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});

previewRoutes.get('/:projectId/logs', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const response = await sandboxStub(c.env, projectId).fetch(
    `${SANDBOX_CONTROL_ORIGIN}/logs`
  );
  return new Response(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

// proxyToSandbox — forwards live-app requests through to the running dev
// server. Ownership is still enforced (unlike a public deploy URL, preview
// traffic requires the founder's own session/virtual key).
previewRoutes.all('/:projectId/proxy/*', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectOwner(c.env.DB, projectId, userId);

  const prefix = `/api/preview/${projectId}/proxy`;
  const inboundUrl = new URL(c.req.url);
  const forwardedPath = inboundUrl.pathname.slice(prefix.length) || '/';
  const target = new Request(
    `https://sandbox${forwardedPath}${inboundUrl.search}`,
    c.req.raw
  );

  return sandboxStub(c.env, projectId).fetch(target);
});

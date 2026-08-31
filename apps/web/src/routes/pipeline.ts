/**
 * Pipeline — the routes driving the 5-agent "CTO-in-a-Box" system
 * (researcher, auditor, verifier, designer, coder).
 * See @agent_docs/api-spec.md "Pipeline" and @agent_docs/autonomous-dev-team.md.
 *
 * The GenerationOrchestrator DO (state machine + agent execution, see
 * durable-objects/GenerationOrchestrator.ts) is live and does the actual
 * agent work; this route layer owns the D1-backed pipeline_runs/steps/
 * blueprints records and the HTTP/SSE contract the frontend depends on.
 * POST / and POST /:id/approve nudge the DO via kickOffOrchestrator below;
 * GET streams pipeline_runs/pipeline_steps state directly from D1 by
 * polling, not by reading from the DO.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { BicameralError, CreditsError } from '@bicameral/shared/errors';
import { CREDIT_COSTS, SIM_EVOLVED } from '@bicameral/shared/constants';
import type { ExecutionMode, PipelineStatus } from '@bicameral/shared/types';
import { normalizeExecutionMode } from '@bicameral/shared/types';
import { debitCredits } from '../lib/virtual-key.js';
import { selectModel } from '../lib/cohere.js';
import { resolveGate, isAwaitingApproval } from '../pipeline/gates.js';
import {
  messageVisibleAt,
  normalizeVerboseness,
  redactSecrets,
  showsStepTelemetry,
} from '../lib/verboseness.js';
import { loadUserSettings } from './settings.js';
import { fetchLatticeContext } from '../lib/lattice-context.js';
import {
  emptySuggestionReason,
  suggestBlocks,
  type ExistingComponent,
} from '../lib/block-suggestions.js';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const pipelineRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

/**
 * The window `SIM_EVOLVED.conversationTurnLimit` is counted over. Named once
 * because it was previously spelled three times in three notations — a SQL
 * modifier string, the words "15-minute" in the founder-facing message, and
 * `retry_after_seconds: 900` — which is how a limit comes to advertise a
 * window it does not enforce.
 */
const TURN_LIMIT_WINDOW_MS = 15 * 60 * 1000;

interface PipelineRunRow {
  id: string;
  user_id: string;
  project_id: string | null;
  prompt: string;
  status: PipelineStatus;
  current_step: number;
  current_agent: string | null;
  gate_status: string | null;
  gate_feedback: string | null;
  deployment_url: string | null;
  error_message: string | null;
  started_at: string | null;
  created_date: string;
  updated_date: string;
}

interface PipelineStepRow {
  id: string;
  step_number: number;
  agent_role: string;
  model_used: string;
  output: string | null;
  status: string;
  iteration: number;
  error_message: string | null;
}

/** The step columns the verbose transcript reports. Separate from
 * `PipelineStepRow` (which the SSE stream uses) because these are the
 * telemetry fields, and the SSE frame deliberately does not carry them. */
interface PipelineTelemetryRow {
  step_number: number;
  agent_role: string;
  model_used: string;
  status: string;
  iteration: number;
  tokens_in: number;
  tokens_out: number;
  credits_used: number;
  duration_ms: number | null;
}

// 'paused' means the approval gate timed out (see pipeline/gates.ts) — the
// run isn't cancelled, but there's nothing more for this SSE stream to say
// until a founder acts, so treat it as a stream-closing state too.
const TERMINAL_STATUSES: PipelineStatus[] = ['deployed', 'error', 'paused'];

function safeJsonParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadOwnedRun(
  db: D1Database,
  id: string,
  userId: string
): Promise<PipelineRunRow> {
  const row = await db
    .prepare('SELECT * FROM pipeline_runs WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<PipelineRunRow>();
  if (!row)
    throw new BicameralError(
      'Pipeline run not found',
      'PIPELINE_NOT_FOUND',
      404
    );
  return row;
}

/**
 * Every run gets a project, whether or not the caller named one.
 *
 * `project_id` is nullable and the Generation view has always sent nothing,
 * so every run started from the product's main entry point had a null one.
 * That is not a cosmetic gap: the preview container is keyed by project
 * (`PREVIEW_SANDBOX.idFromName(projectId)`), ownership is checked against
 * `projects`, and the blueprint the sandbox needs for its API routes is found
 * by joining `pipeline_runs` on `project_id`. With no project there is nothing
 * to key a preview on, which is a large part of why Tier 3 had never run.
 * `GenerationOrchestrator` also threads `run.project_id` into lattice nodes and
 * eight other writes, all of which were being filed under null.
 *
 * The name is the prompt's first line, trimmed — a founder should recognise
 * the row in Projects without having opened it.
 */
async function ensureProject(
  db: D1Database,
  userId: string,
  givenProjectId: string | undefined,
  prompt: string,
  now: string
): Promise<string> {
  if (givenProjectId) {
    const owned = await db
      .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
      .bind(givenProjectId, userId)
      .first<{ id: string }>();
    if (!owned)
      throw new BicameralError('Project not found', 'PROJECT_NOT_FOUND', 404);
    return givenProjectId;
  }

  const id = crypto.randomUUID();
  const firstLine = prompt.split('\n')[0].trim();
  const name =
    firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
  await db
    .prepare(
      `INSERT INTO projects (id, user_id, name, description, status,
         created_date, updated_date, created_by)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .bind(id, userId, name || 'Untitled project', prompt, now, now, userId)
    .run();
  return id;
}

/** Fire-and-forget nudge to the GenerationOrchestrator DO. Nothing else
 * re-nudges it — the SSE route below only polls `pipeline_runs`/
 * `pipeline_steps`, it never re-POSTs `/run` on reconnect — so if this
 * particular call fails to even reach the DO (bad binding, network error
 * getting the stub), the run would otherwise sit at 'pending' forever with
 * no explanation, and the GET stream would just show static step badges
 * for up to 5 minutes before giving up silently. (Failures *inside* the
 * DO's own pipeline run are handled separately by its `recordFailure`,
 * which already writes `status='error'` — this only covers not reaching
 * the DO at all.) Write the same status='error' shape here so the existing
 * SSE error-event path (see the GET handler's `run.status === 'error'`
 * branch) picks it up instead of the UI staying silent. */
async function kickOffOrchestrator(
  db: D1Database,
  env: Env,
  pipelineRunId: string
): Promise<void> {
  const fail = async (context: string, err: unknown) => {
    console.error(`kickOffOrchestrator: ${context}`, pipelineRunId, err);
    const message =
      err instanceof Error ? err.message : 'Failed to start pipeline';
    // Guard against clobbering a status that already moved on by the time
    // this async failure handler runs — covers both the initial POST /
    // (status still 'pending') and the approve route (status already past
    // 'awaiting_approval'), without overwriting a run that's already
    // terminal.
    await db
      .prepare(
        "UPDATE pipeline_runs SET status = 'error', error_message = ?, updated_date = ? WHERE id = ? AND status NOT IN ('deployed', 'error', 'paused')"
      )
      .bind(
        `Could not start pipeline: ${message}`,
        new Date().toISOString(),
        pipelineRunId
      )
      .run();
  };

  try {
    const stub = env.GENERATION_DO.get(
      env.GENERATION_DO.idFromName(pipelineRunId)
    );
    await stub.fetch('https://do/run', { method: 'POST' }).catch((err) => {
      void fail('DO fetch failed', err);
    });
  } catch (err) {
    await fail('failed to get DO stub', err);
  }
}

interface StartRunBody {
  prompt?: string;
  projectId?: string;
  executionMode?: string;
}

/**
 * Starts a run. Shared by `POST /` and `POST /unified` so the turn limit, the
 * credit debit and their ordering cannot drift apart between two entry points.
 *
 * `forcedMode`, when given, overrides whatever the client asked for. Only the
 * unified route passes it, and only to pin `auto_accept`.
 */
async function startPipelineRun(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  forcedMode?: ExecutionMode
) {
  const userId = c.get('userId');
  const body = await c.req.json<StartRunBody>();
  if (!body.prompt) {
    throw new BicameralError('prompt is required', 'VALIDATION_ERROR', 400);
  }
  // normalizeExecutionMode owns the allowlist now, so the route and the
  // orchestrator cannot disagree about which modes exist. A client still
  // sending the retired `dangerously_automated` gets `auto_accept` — what that
  // mode always did — rather than being silently dropped to `ask_first`, which
  // would change the behaviour of an integration that never asked for it.
  const executionMode =
    forcedMode ?? normalizeExecutionMode(body.executionMode);

  // Simulation-evolved conversation turn limit (Butterfly v7).
  //
  // This runs BEFORE debitCredits and before the pipeline_runs insert. It used
  // to run after both — and after `waitUntil(kickOffOrchestrator(...))` — so an
  // over-limit caller was charged, had a run started in the background, and was
  // then told the request was refused. A 429 issued after the side effects is
  // not a rejection; it is a charge with a rejection message attached.
  //
  // The window bound is computed in JS rather than in SQL, and that is
  // load-bearing rather than stylistic. `created_date` is written with
  // toISOString() ("2026-08-31T03:33:23.704Z"), while SQLite renders
  // datetime('now','-15 minutes') as "2026-08-31 06:18:23" — space separator,
  // no zone. D1 compares TEXT lexicographically and 'T' (0x54) sorts above
  // ' ' (0x20), so against a SQL-rendered bound EVERY row written on the same
  // calendar day compares as "inside the window". Measured in sqlite3: a
  // three-hour-old row and a midnight row both test as recent. A founder with
  // 15 runs at any hour would be refused for the rest of the day.
  //
  // The previous binding was `datetime(?, ?)` with ('-15 minutes', 'now') —
  // the arguments reversed. SQLite's datetime() takes (timevalue, modifier...),
  // so that expression returns NULL, `created_date > NULL` is NULL, and the
  // limit had never fired even once. Correcting only the argument order would
  // have swapped a limit that never fires for one that fires all day; both
  // halves are needed. lib/chat-quota.ts records the same trap on the same
  // column convention.
  const since = new Date(Date.now() - TURN_LIMIT_WINDOW_MS).toISOString();
  const recentRuns = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM pipeline_runs WHERE user_id = ? AND created_date > ?'
  )
    .bind(userId, since)
    .first<{ count: number }>();

  if (recentRuns && recentRuns.count >= SIM_EVOLVED.conversationTurnLimit) {
    return c.json(
      {
        error: 'Conversation turn limit reached',
        detail:
          `Maximum ${SIM_EVOLVED.conversationTurnLimit} pipeline runs per ` +
          `${TURN_LIMIT_WINDOW_MS / 60_000}-minute window. Please wait before ` +
          `starting a new generation.`,
        retry_after_seconds: TURN_LIMIT_WINDOW_MS / 1000,
      },
      429
    );
  }

  const debited = await debitCredits(c.env.DB, userId, CREDIT_COSTS.generation);
  if (!debited) throw new CreditsError();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const projectId = await ensureProject(
    c.env.DB,
    userId,
    body.projectId,
    body.prompt,
    now
  );

  await c.env.DB.prepare(
    `INSERT INTO pipeline_runs (
       id, user_id, project_id, prompt, status, current_step, current_agent,
       total_credits_used, total_tokens_in, total_tokens_out,
       started_at, created_date, updated_date, created_by, execution_mode
     ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, 0, 0, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      projectId,
      body.prompt,
      CREDIT_COSTS.generation,
      now,
      now,
      now,
      userId,
      executionMode
    )
    .run();

  c.executionCtx.waitUntil(kickOffOrchestrator(c.env.DB, c.env, id));

  // `projectId` is part of the response because the client needs it to reach
  // /api/preview/:projectId. Without it the founder's browser holds a pipeline
  // id and nothing else, and the full-stack preview is unaddressable.
  return c.json(
    { pipelineId: id, projectId, status: 'pending', executionMode },
    201
  );
}

pipelineRoutes.post('/', async (c) => startPipelineRun(c));

// ============ POST /api/pipeline/unified ============
/**
 * The 5-in-1 pipeline: one request, the four pre-gate stages run end to end,
 * and what comes back to the founder is a blueprint that has already been
 * audited and verified.
 *
 * What this is NOT: a second sequencer. The five stages already run in order
 * inside `GenerationOrchestrator`, with an independent-provider audit between
 * research and verification. Consolidating them again in a route would mean two
 * implementations of the same ordering, and the one this route did not use
 * would be the one that kept the gates.
 *
 * What it actually changes is where a human is asked to stand. In `ask_first`
 * the run stops at every INTER-AGENT gate — after the researcher, after the
 * auditor, after the verifier — so producing a blueprint takes four separate
 * approvals from someone who has not seen a blueprint yet and cannot judge the
 * intermediate artefacts. This route pins `auto_accept`, so those four gates
 * auto-advance and are logged rather than waited on, and the founder is asked
 * once, about the thing they can actually evaluate.
 *
 * Two boundaries this does not move, and must not:
 *
 *  - **The human blueprint gate is unconditional.** The designer step sets
 *    `status = 'awaiting_approval'` with no reference to execution mode, so
 *    step 5 (the coder — the expensive, hard-to-reverse one) still waits for a
 *    person here exactly as it does on `POST /`. "Pre-verified" describes what
 *    the blueprint has been through, not permission to skip reading it.
 *  - **`ask_first` remains the default.** This is an explicit, separately
 *    addressed endpoint. `POST /` is untouched and still defaults to pausing at
 *    every gate; nothing here changes what an existing client gets.
 *
 * Everything else — the turn limit, its ordering before the credit debit, the
 * project row — is the same code path, by construction.
 */
pipelineRoutes.post('/unified', async (c) =>
  startPipelineRun(c, 'auto_accept')
);

pipelineRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT id, prompt, status, current_step, current_agent, total_credits_used, started_at, created_date, updated_date
     FROM pipeline_runs
     WHERE created_by = ?
     ORDER BY created_date DESC
     LIMIT 50`
  )
    .bind(userId)
    .all();
  return c.json({ runs: results ?? [] });
});

/**
 * GET /api/pipeline/stuck — Detect stuck pipeline runs (pending >5 min).
 * Returns runs that are likely stuck and need recovery.
 * Powers the pipeline auto-recovery system (NS1 + NS3: detect and resolve
 * value gaps before the user notices).
 */
pipelineRoutes.get('/stuck', async (c) => {
  const userId = c.get('userId');
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const stuck = await c.env.DB.prepare(
    `SELECT id, prompt, status, current_step, current_agent, total_credits_used, started_at, created_date
     FROM pipeline_runs
     WHERE created_by = ? AND status = 'pending' AND created_date < ?
     ORDER BY created_date ASC`
  )
    .bind(userId, fiveMinutesAgo)
    .all();

  return c.json({
    stuckRuns: (stuck.results ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const createdAt = new Date(row.created_date as string);
      const elapsed = Math.floor((Date.now() - createdAt.getTime()) / 1000);
      return {
        id: row.id,
        prompt: (row.prompt as string)?.slice(0, 100),
        status: row.status,
        currentStep: row.current_step,
        currentAgent: row.current_agent,
        creditsUsed: row.total_credits_used,
        elapsedSeconds: elapsed,
        elapsedDisplay:
          elapsed > 60
            ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
            : `${elapsed}s`,
      };
    }),
  });
});

pipelineRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const ownedRun = await loadOwnedRun(c.env.DB, id, userId);

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );

      // Sent once, first, before any polling. This stream is also how the
      // client recovers state after a reload — it replays from current D1 row
      // state rather than from a live-only push — so the project id has to
      // come down it too, or a reloaded page can no longer address the
      // preview container the run's project owns.
      // `startedAt` rides along for the same reason as the project id: the
      // header shows how long this run has been going, and a client-side clock
      // started on mount would reset to zero on every reload and read as "just
      // started" for a run that had been going for four minutes. The server row
      // is the only thing that knows when it actually began.
      send({
        type: 'pipeline:context',
        projectId: ownedRun.project_id,
        startedAt: ownedRun.started_at ?? ownedRun.created_date ?? null,
      });

      // Keyed by pipeline_steps.id (not step_number — the Coder step
      // reuses step_number 4 across multiple iteration rows) rather than a
      // monotonic count: a step observed while still 'running' must be
      // revisited once it flips to 'completed'/'failed', or its
      // step:complete (and output) never reaches the frontend. See the
      // Phase 9 local-test notes — this is what left the blueprint gate
      // showing no blueprint (Designer's step:complete was skipped because
      // the count had already advanced past it while it was 'running').
      const lastSentRowStatus = new Map<string, string>();
      let lastStatus: string | null = null;
      let coderStepStarted = false;

      // Poll the D1-backed run/step records until the pipeline reaches a
      // terminal state. GenerationOrchestrator writes these rows directly
      // (no WebSocket push for pipeline progress — see its docstring); this
      // loop is what turns that D1 state into the documented SSE contract.
      // The whole tick body is guarded so a transient D1 failure ends the
      // stream cleanly (one error frame) instead of throwing uncaught
      // inside the ReadableStream constructor.
      for (let tick = 0; tick < 300; tick++) {
        let run: PipelineRunRow | null;
        try {
          run = await c.env.DB.prepare(
            'SELECT * FROM pipeline_runs WHERE id = ?'
          )
            .bind(id)
            .first<PipelineRunRow>();
        } catch (err) {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : 'Database error',
          });
          break;
        }
        if (!run) {
          send({ type: 'error', message: 'Pipeline run vanished' });
          break;
        }

        if (run.status !== lastStatus) {
          if (run.status === 'awaiting_approval') {
            send({
              type: 'gate:awaiting_approval',
              message: 'Review your blueprint to continue',
            });
          } else if (run.status === 'error') {
            send({
              type: 'error',
              message: run.error_message ?? 'Pipeline failed',
            });
          } else if (run.status === 'paused') {
            send({
              type: 'error',
              message:
                'Approval gate timed out after 24 hours — pipeline paused',
            });
          } else if (run.status === 'deployed') {
            const generation = await c.env.DB.prepare(
              'SELECT files FROM generations WHERE pipeline_run_id = ? ORDER BY created_date DESC LIMIT 1'
            )
              .bind(id)
              .first<{ files: string | null }>();
            send({
              type: 'pipeline:complete',
              deploymentUrl: run.deployment_url,
              files: safeJsonParse(generation?.files ?? null) ?? [],
            });
          }
          lastStatus = run.status;
        }

        let steps: D1Result<PipelineStepRow>;
        try {
          steps = await c.env.DB.prepare(
            'SELECT * FROM pipeline_steps WHERE pipeline_run_id = ? ORDER BY step_number ASC, created_date ASC'
          )
            .bind(id)
            .all<PipelineStepRow>();
        } catch (err) {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : 'Database error',
          });
          break;
        }

        for (const step of steps.results) {
          // Only (re)send once this row's status has actually changed since
          // the last frame we emitted for it — not just "is this row new to
          // us" (see the Map's docstring above for why a count-based cursor
          // drops completions that land between polls).
          if (lastSentRowStatus.get(step.id) === step.status) continue;
          lastSentRowStatus.set(step.id, step.status);

          const output =
            step.status === 'completed' ? safeJsonParse(step.output) : null;

          if (step.agent_role === 'coder') {
            // Each Coder iteration is its own pipeline_steps row (see
            // GenerationOrchestrator.runCoderStep). The first one still
            // opens with step:start; every row (including the first)
            // reports its outcome as iteration:complete per the documented
            // event flow.
            if (!coderStepStarted) {
              send({
                type: 'step:start',
                // `step.step_number`, not a literal. This said `step: 4` and
                // the Coder's rows are written with step_number 5
                // (GenerationOrchestrator.startStep, line ~850), so the one
                // frame announcing the build reported the Designer's number.
                // The client derives the agent from the number and ignores
                // the `agent` field beside it, so for the whole build the UI
                // believed the Designer was still working: the rail lit
                // Design, "Build" stayed pending, and the header said the
                // blueprint was being written while files were being
                // generated. Nothing failed — it just described the wrong
                // stage, which is precisely the defect §3.4 exists to close.
                step: step.step_number,
                agent: 'coder',
                model: step.model_used,
              });
              coderStepStarted = true;
            }
            if (step.status !== 'running') {
              const coderOutput = output as {
                errors?: unknown[];
                fixed?: boolean;
              } | null;
              send({
                type: 'iteration:complete',
                iteration: step.iteration,
                errors: Array.isArray(coderOutput?.errors)
                  ? coderOutput.errors.length
                  : step.status === 'failed'
                    ? 1
                    : 0,
                fixed:
                  step.status === 'completed'
                    ? Boolean(coderOutput?.fixed)
                    : false,
              });
            }
            continue;
          }

          send({
            type: step.status === 'completed' ? 'step:complete' : 'step:start',
            step: step.step_number,
            agent: step.agent_role,
            model: step.model_used,
            ...(output ? { output } : {}),
            ...(step.status === 'failed' ? { error: step.error_message } : {}),
          });
        }

        if (TERMINAL_STATUSES.includes(run.status)) break;

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

pipelineRoutes.post('/:id/approve', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const run = await loadOwnedRun(c.env.DB, id, userId);

  if (!isAwaitingApproval(run)) {
    throw new BicameralError(
      `Pipeline is not awaiting approval (status: ${run.status})`,
      'PIPELINE_NOT_AWAITING_APPROVAL',
      409
    );
  }

  const body = await c.req.json<{ approved: boolean; feedback?: string }>();
  // Store feedback (user's edit/mutation of the hand-off message) for the next agent
  await c.env.DB.prepare(
    'UPDATE pipeline_runs SET gate_feedback = ? WHERE id = ?'
  )
    .bind(body.feedback ?? null, id)
    .run();

  const result = await resolveGate(
    c.env.DB,
    id,
    body.approved,
    body.feedback ?? null
  );
  c.executionCtx.waitUntil(kickOffOrchestrator(c.env.DB, c.env, id));
  return c.json(result);
});

/**
 * GET /api/pipeline/:id/messages — Group chat messages from all agents.
 *
 * Powers the Group Chat UI where all 5 agents publish reasoning, outputs, and
 * consensus states in a single shared thread — now projected at the caller's
 * verboseness level (§3.3). See lib/verboseness.ts for what each level
 * promises.
 *
 * Three things about the shape here are deliberate:
 *
 * - **The whole history is re-read on every call and filtered at the level
 *   asked for.** That is what makes raising the level mid-run reveal what
 *   already happened without a re-run: the record was always complete, and
 *   only the projection was narrow. It is also why the level is applied here
 *   rather than at write time — a run recorded at quiet could never be opened
 *   up afterwards.
 * - **`stages` is returned at every level.** The panel used to infer each
 *   agent's status from the presence of that agent's `output` message, so
 *   filtering messages would have made a quiet run look permanently stuck. A
 *   display preference must not change what the pipeline appears to have done.
 * - **`?verboseness=` overrides the stored setting for this response only.**
 *   The UI sends the level it is currently rendering so a founder who changes
 *   the control sees the effect on the next poll rather than after the PATCH
 *   round-trips.
 */
pipelineRoutes.get('/:id/messages', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await loadOwnedRun(c.env.DB, id, userId);

  const requested = c.req.query('verboseness');
  const level = requested
    ? normalizeVerboseness(requested)
    : (await loadUserSettings(c.env.DB, userId)).verboseness;

  const { results } = await c.env.DB.prepare(
    `SELECT id, step, message_type, content, metadata, created_at
     FROM agent_messages
     WHERE pipeline_run_id = ?
     ORDER BY created_at ASC`
  )
    .bind(id)
    .all();

  const messages = (results ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((row) => messageVisibleAt(String(row.message_type), level))
    .map((row) => ({
      id: row.id,
      step: row.step,
      messageType: row.message_type,
      content: row.content,
      // Redacted on the way out rather than on the way in: the stored record
      // is the audit trail, and this is the copy that reaches a browser.
      metadata: redactSecrets(safeJsonParse(row.metadata as string | null)),
      createdAt: row.created_at,
    }));

  const stepRows = await c.env.DB.prepare(
    `SELECT step_number, agent_role, model_used, status, iteration,
            tokens_in, tokens_out, credits_used, duration_ms
     FROM pipeline_steps
     WHERE pipeline_run_id = ?
     ORDER BY step_number ASC, created_date ASC`
  )
    .bind(id)
    .all<PipelineTelemetryRow>();

  const stages = (stepRows.results ?? []).map((step) => ({
    step: step.step_number,
    agent: step.agent_role,
    status: step.status,
    iteration: step.iteration,
    // The model id is the founder's only way to see for themselves that the
    // audit step runs on a different provider's model from the work it grades
    // (see "The independent auditor" in CLAUDE.md). It is recorded per step
    // from the same `selectModel` call that dispatched it, so it is what ran
    // and not what a display table says should have run.
    ...(showsStepTelemetry(level)
      ? {
          model: step.model_used,
          tokensIn: step.tokens_in,
          tokensOut: step.tokens_out,
          creditsUsed: step.credits_used,
          durationMs: step.duration_ms,
        }
      : {}),
  }));

  return c.json({ verboseness: level, stages, messages });
});

/**
 * POST /api/pipeline/:id/retry — Force the current agent to retry its
 * evaluation pass. Sets gate_feedback and re-nudges the orchestrator,
 * which re-runs the current step with the user's feedback.
 */
pipelineRoutes.post('/:id/retry', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const run = await loadOwnedRun(c.env.DB, id, userId);

  if (!isAwaitingApproval(run)) {
    throw new BicameralError(
      `Pipeline is not at a gate (status: ${run.status})`,
      'PIPELINE_NOT_AT_GATE',
      409
    );
  }

  const body = await c.req.json<{ feedback?: string }>();

  // Set feedback for the current agent's retry
  await c.env.DB.prepare(
    'UPDATE pipeline_runs SET gate_feedback = ?, status = ?, updated_date = ? WHERE id = ?'
  )
    .bind(
      body.feedback ?? 'Please retry with improvements',
      // Reset to the step before the gate — the orchestrator will re-run it
      run.current_agent === 'researcher'
        ? 'researching'
        : run.current_agent === 'auditor'
          ? 'auditing'
          : run.current_agent === 'verifier'
            ? 'verifying'
            : 'designing',
      new Date().toISOString(),
      id
    )
    .run();

  c.executionCtx.waitUntil(kickOffOrchestrator(c.env.DB, c.env, id));
  return c.json({ success: true, status: 'retrying' });
});

pipelineRoutes.post('/:id/cancel', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await loadOwnedRun(c.env.DB, id, userId);

  await c.env.DB.prepare(
    "UPDATE pipeline_runs SET status = 'error', error_message = 'Cancelled by user', completed_at = ?, updated_date = ? WHERE id = ?"
  )
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run();

  return c.json({ success: true, status: 'cancelled' });
});

pipelineRoutes.get('/:id/blueprint', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  await loadOwnedRun(c.env.DB, id, userId);

  const blueprint = await c.env.DB.prepare(
    'SELECT * FROM blueprints WHERE pipeline_run_id = ? ORDER BY version DESC LIMIT 1'
  )
    .bind(id)
    .first<{
      id: string;
      components: string;
      database_schema: string | null;
      api_routes: string | null;
      auth_strategy: string | null;
      env_vars: string | null;
      deploy_config: string | null;
    }>();

  if (!blueprint) {
    throw new BicameralError(
      'Blueprint not yet available',
      'BLUEPRINT_NOT_FOUND',
      404
    );
  }

  return c.json({
    id: blueprint.id,
    components: JSON.parse(blueprint.components),
    databaseSchema: blueprint.database_schema
      ? JSON.parse(blueprint.database_schema)
      : null,
    apiRoutes: blueprint.api_routes ? JSON.parse(blueprint.api_routes) : null,
    authStrategy: blueprint.auth_strategy,
    envVars: blueprint.env_vars ? JSON.parse(blueprint.env_vars) : [],
    deployConfig: blueprint.deploy_config
      ? JSON.parse(blueprint.deploy_config)
      : {},
  });
});

// ============ GET /api/pipeline/:id/block-suggestions ============
/**
 * Modular blocks the Memory Lattice says this project needs and this blueprint
 * does not yet have. Rendered at the review gate, beside the blueprint the
 * founder is deciding on.
 *
 * It is a separate request from `/blueprint` on purpose. The blueprint is what
 * the pipeline produced and what approval applies to; these are proposals
 * derived afterwards from a different record, and merging them into one payload
 * would make it possible to read a suggestion as part of what the designer
 * decided. `lib/block-suggestions.ts` carries the reasoning and its limits.
 *
 * Empty is a real answer, and it comes back with the reason — an empty lattice
 * and a fully-covered one are different facts and a bare `[]` states neither.
 */
pipelineRoutes.get('/:id/block-suggestions', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const run = await loadOwnedRun(c.env.DB, id, userId);

  const blueprint = await c.env.DB.prepare(
    'SELECT components FROM blueprints WHERE pipeline_run_id = ? ORDER BY version DESC LIMIT 1'
  )
    .bind(id)
    .first<{ components: string }>();

  const parsed = safeJsonParse(blueprint?.components ?? null);
  const components: ExistingComponent[] = Array.isArray(parsed)
    ? (parsed as Array<{ path?: unknown; description?: unknown }>).map((x) => ({
        path: typeof x.path === 'string' ? x.path : '',
        description: typeof x.description === 'string' ? x.description : '',
      }))
    : [];

  // Scoped to this run's project, and to the owner — fetchLatticeContext joins
  // projects on userId, so run.project_id is a narrowing and not a trust.
  const context = await fetchLatticeContext(c.env.DB, userId, {
    projectId: run.project_id,
  });

  const input = { context, components };
  const suggestions = suggestBlocks(input);
  return c.json({
    suggestions,
    reason: suggestions.length === 0 ? emptySuggestionReason(input) : null,
  });
});

/**
 * POST /:id/iterate — Chat-based code iteration.
 *
 * Takes the current files + user's natural language request, calls Cohere
 * Command A to generate updated file contents, and returns them.
 *
 * This is the Discomplement research-audit-implement-audit loop:
 * 1. Research: embed the request, retrieve relevant code from the lattice
 * 2. Audit: check the changes don't reverse any decision axes (drift)
 * 3. Implement: send files + request to Cohere, get back updated files
 * 4. Audit: validate the returned files are parseable and complete
 */
pipelineRoutes.post('/:id/iterate', async (c) => {
  const env = c.env;
  const body = await c.req.json<{
    prompt: string;
    files: Array<{ path: string; content: string }>;
  }>();

  if (!body.prompt?.trim()) {
    return c.json({ error: 'Prompt is required' }, 400);
  }
  if (!body.files?.length) {
    return c.json({ error: 'No files to iterate on' }, 400);
  }

  // Build the file context for the LLM
  const fileContext = body.files
    .map((f) => `--- FILE: ${f.path} ---\n${f.content}`)
    .join('\n\n');

  // Call Cohere Command A to generate updated files
  const cohereResponse = await fetch('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.COHERE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // Was the literal 'command-a-03-2025' — a direct dispatch, not just a
      // stale label, so this endpoint was calling a model the router retired
      // on 2026-08-21 (finding M-19). Route it like every other coder call.
      model: selectModel('coder', 'simple'),
      messages: [
        {
          role: 'system',
          content: `You are a code iteration agent for Discomplement. The user has an existing React app and wants to modify it. You will receive the current files and a natural language request. Return the updated files in this exact JSON format:

{"files": [{"path": "relative/path.tsx", "content": "full file content here"}], "message": "Brief description of what you changed"}

Rules:
- Return ONLY valid JSON, no markdown fences, no explanations outside the JSON
- Include ALL files that changed, with their FULL content (not diffs)
- If adding a new file, include it with its full path and content
- If the request doesn't require changes to a file, don't include it
- Keep the same coding style, imports, and patterns as the existing code
- Use React 19 with TypeScript, esm.sh for external imports`,
        },
        {
          role: 'user',
          content: `Current files:\n\n${fileContext}\n\nUser request: ${body.prompt}`,
        },
      ],
      max_tokens: 8000,
      temperature: 0.3,
      // No `thinking` field: selectModel() resolves the coder to
      // command-a-03-2025, which rejects the parameter with a 422 rather than
      // ignoring it. (It was sent as `{type:'disabled'}` while the coder ran
      // on a reasoning model, to stop reasoning tokens eating max_tokens.)
    }),
  });

  if (!cohereResponse.ok) {
    const errText = await cohereResponse.text();
    return c.json(
      { error: `Cohere API error: ${cohereResponse.status}`, detail: errText },
      502
    );
  }

  const cohereData = (await cohereResponse.json()) as {
    message?: { content?: Array<{ type: string; text: string }> };
  };

  // Extract the text response
  let llmText = '';
  for (const item of cohereData.message?.content ?? []) {
    if (item.type === 'text') llmText += item.text;
  }

  // Strip markdown fences if present
  llmText = llmText.trim();
  if (llmText.startsWith('```')) {
    const lines = llmText.split('\n');
    lines.shift(); // Remove opening fence
    if (lines[lines.length - 1].trim() === '```') lines.pop();
    llmText = lines.join('\n');
  }

  // Parse the JSON response
  let parsed: {
    files?: Array<{ path: string; content: string }>;
    message?: string;
  };
  try {
    parsed = JSON.parse(llmText);
  } catch {
    return c.json(
      {
        error: 'Failed to parse LLM response',
        raw: llmText.slice(0, 500),
      },
      502
    );
  }

  // Validate the returned files
  if (!parsed.files?.length) {
    return c.json({
      message: parsed.message ?? 'No file changes needed.',
      files: body.files,
    });
  }

  // Merge: start with existing files, update with returned files
  const fileMap = new Map(body.files.map((f) => [f.path, f.content]));
  for (const f of parsed.files) {
    fileMap.set(f.path, f.content);
  }

  const mergedFiles = Array.from(fileMap.entries()).map(([path, content]) => ({
    path,
    content,
  }));

  return c.json({
    files: mergedFiles,
    message: parsed.message ?? `Updated ${parsed.files.length} file(s).`,
  });
});

/**
 * POST /:id/research — Run the full research stage for a pipeline.
 *
 * This is the "discovery" in dis[cover]co[here][i]mplemented. Before any
 * code generation happens, the research stage:
 * 1. Searches You.com Research API for real-time web intelligence + citations
 * 2. Searches Scite for peer-reviewed research (Smart Citations)
 * 3. Searches GitHub for existing open source code to reuse
 * 4. Reranks all findings with Cohere rerank-v3.5
 * 5. Ingests everything into the Cohere Memory Lattice
 * 6. Returns a recommended approach for the Architect agent
 *
 * This endpoint can be called independently or is triggered automatically
 * by the pipeline orchestrator when a new run starts.
 */
pipelineRoutes.post('/:id/research', async (c) => {
  const pipelineId = c.req.param('id');

  // Fetch the pipeline run to get the prompt
  const run = await c.env.DB.prepare(
    'SELECT prompt, status FROM pipeline_runs WHERE id = ?'
  )
    .bind(pipelineId)
    .first<{ prompt: string; status: string }>();

  if (!run) {
    throw new BicameralError('Pipeline run not found', 'NOT_FOUND', 404);
  }

  // Dynamically import the research engine (keeps initial bundle smaller)
  const { runResearch } = await import('../lib/research-engine.js');

  const result = await runResearch(run.prompt, {
    COHERE_API_KEY: c.env.COHERE_API_KEY,
    GITHUB_TOKEN: c.env.GITHUB_TOKEN ?? '',
    // No `?? ''` here: an empty string is a *present* key to every `if (key)`
    // check downstream, so the coercion is what made unconfigured Scite call
    // out with `Authorization: Bearer `. Pass the absence through.
    SCITE_API_KEY: c.env.SCITE_API_KEY,
    TAVILY_API_KEY: c.env.TAVILY_API_KEY,
    YDC_API_KEY: c.env.YDC_API_KEY ?? '',
  });

  // Store research results as a pipeline step
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO pipeline_steps (
      id, pipeline_run_id, step_number, agent_role, model_used,
      output, status, iteration, created_date, updated_date, created_by
    ) VALUES (?, ?, 0, 'researcher', 'multi-source', ?, 'completed', 0, ?, ?, ?)`
  )
    .bind(
      stepId,
      pipelineId,
      JSON.stringify({
        findings: result.findings,
        recommendedApproach: result.recommendedApproach,
        reusableCode: result.reusableCode.map((c) => ({
          path: c.path,
          source: c.source,
          contentLength: c.content.length,
        })),
        citationContext: result.citationContext,
      }),
      now,
      now,
      c.get('userId')
    )
    .run();

  return c.json({
    pipelineId,
    research: {
      findingsCount: result.findings.length,
      reusableCodeCount: result.reusableCode.length,
      citationConfidence: result.citationContext.confidence,
      recommendedApproach: result.recommendedApproach,
      findings: result.findings.slice(0, 10).map((f) => ({
        type: f.type,
        title: f.title,
        url: f.url,
        source: f.source,
        relevance: f.relevance,
      })),
    },
  });
});

/**
 * POST /api/pipeline/:id/auto-recover — Auto-recover a stuck pipeline run.
 * Cancels the run and refunds credits if the pipeline is stuck for >5 min.
 * This is the autonomous gap resolution mechanism (NS3).
 */
pipelineRoutes.post('/:id/auto-recover', async (c) => {
  const userId = c.get('userId');
  const runId = c.req.param('id');
  const now = new Date().toISOString();

  // Get the run
  const run = await c.env.DB.prepare(
    'SELECT id, status, total_credits_used, created_date FROM pipeline_runs WHERE id = ? AND created_by = ?'
  )
    .bind(runId, userId)
    .first<{
      id: string;
      status: string;
      total_credits_used: number;
      created_date: string;
    }>();

  if (!run) return c.json({ error: 'Pipeline run not found' }, 404);
  if (run.status !== 'pending')
    return c.json({ error: 'Run is not stuck (status is not pending)' }, 400);

  const elapsed = Date.now() - new Date(run.created_date).getTime();
  if (elapsed < 5 * 60 * 1000) {
    return c.json(
      { error: 'Run has not been stuck long enough (<5 min)' },
      400
    );
  }

  // Cancel the run and refund credits
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE pipeline_runs SET status = ?, error_message = ?, updated_date = ? WHERE id = ?'
    ).bind(
      'cancelled',
      'Auto-recovered: pipeline stuck for >5 minutes',
      now,
      runId
    ),
    c.env.DB.prepare(
      'UPDATE users SET credits_remaining = credits_remaining + ?, updated_date = ? WHERE id = ?'
    ).bind(run.total_credits_used, now, userId),
    c.env.DB.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, type, description, pipeline_run_id, created_date, created_by)
       VALUES (?, ?, ?, 'credit', 'Auto-recovery refund: pipeline stuck >5 min', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      userId,
      run.total_credits_used,
      runId,
      now,
      userId
    ),
  ]);

  return c.json({
    recovered: true,
    runId,
    creditsRefunded: run.total_credits_used,
    message:
      'Pipeline was stuck and has been auto-recovered. Credits refunded.',
  });
});

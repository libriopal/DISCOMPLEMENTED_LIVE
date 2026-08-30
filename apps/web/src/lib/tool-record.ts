/**
 * Records that a pipeline tool ran.
 *
 * §3.3 lists tool calls among the things verbose mode must show. Nothing was
 * recording them, and the reason turned out to be worth writing down rather
 * than papering over:
 *
 * **The pipeline agents make no model-issued tool calls at all.** `chat()`
 * sends Cohere tool definitions purely as a structured-output schema — that is
 * what CLAUDE.md means by "Cohere structured outputs (tools) for JSON
 * compliance between agents" — and `chatWithToolLoop`, the function that would
 * run a real tool loop, has no call site outside its own module. So a verbose
 * view rendering "model tool calls" would have had nothing to render, forever,
 * and an empty section would have said something false: that the agents
 * considered using a tool and declined.
 *
 * What does happen is that agent *code* invokes the modules in
 * `pipeline/tools/` directly — `webSearch` from the researcher, `writeFiles`
 * and `runPreview` from the coder. Those are real, they cost real quota and
 * real time, and they are the calls a founder watching a run actually wants
 * accounted for. This records those, and the display names them for what they
 * are: the pipeline calling a tool, not a model deciding to.
 *
 * Failures here are swallowed. A telemetry write must never be the thing that
 * fails a founder's generation — but it is logged, because a recorder that
 * silently records nothing is the failure mode this whole module exists to
 * fix.
 */
import type { AgentRole } from '@bicameral/shared/types';

export interface ToolInvocation {
  /** Which agent's code made the call. */
  agent: AgentRole;
  /** The tool module's name, e.g. `web-search`. */
  tool: string;
  /** One line, for a founder: what it did and how it went. */
  summary: string;
  /** Structured detail. Redacted at the boundary by lib/verboseness.ts. */
  detail?: Record<string, unknown>;
  durationMs?: number;
}

export async function recordToolInvocation(
  db: D1Database,
  pipelineRunId: string | null | undefined,
  invocation: ToolInvocation
): Promise<void> {
  // A run id is optional on several agent contexts, and a tool call outside a
  // run (a test, a direct invocation) has nowhere to be filed.
  if (!pipelineRunId) return;

  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO agent_messages (id, pipeline_run_id, step, message_type, content, metadata, created_at, created_date)
         VALUES (?, ?, ?, 'tool', ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        pipelineRunId,
        invocation.agent,
        invocation.summary,
        JSON.stringify({
          tool: invocation.tool,
          ...(invocation.durationMs !== undefined
            ? { durationMs: invocation.durationMs }
            : {}),
          ...(invocation.detail ?? {}),
        }),
        now,
        now
      )
      .run();
  } catch (err) {
    console.warn(
      `[tool-record] failed to record ${invocation.tool} for run ${pipelineRunId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Runs a tool and records the call, whichever way it goes.
 *
 * A tool that threw is the invocation most worth seeing — the researcher
 * swallows a failed `webSearch` and falls back to the model's own knowledge,
 * which is a defensible behaviour and an invisible one. At verbose, it stops
 * being invisible.
 */
export async function withToolRecord<T>(
  db: D1Database,
  pipelineRunId: string | null | undefined,
  invocation: Omit<ToolInvocation, 'summary' | 'durationMs'>,
  run: () => Promise<T> | T,
  describe: (result: T) => string
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    await recordToolInvocation(db, pipelineRunId, {
      ...invocation,
      summary: describe(result),
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    await recordToolInvocation(db, pipelineRunId, {
      ...invocation,
      summary: `${invocation.tool} failed: ${err instanceof Error ? err.message : String(err)}`,
      detail: { ...(invocation.detail ?? {}), failed: true },
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

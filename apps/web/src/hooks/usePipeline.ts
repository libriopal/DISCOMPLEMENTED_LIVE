/**
 * Pipeline lifecycle hook — start / approve / cancel against
 * routes/pipeline.ts, and a reduced view of useGenerationStream's raw SSE
 * events for the GenerationView UI (4-step progress, blueprint gate,
 * per-agent output cards, coder iteration count).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useGenerationStream,
  type PipelineEvent,
} from './useGenerationStream.js';
import type { AgentRole, ProjectFile } from '@bicameral/shared/types';

// 5-agent pipeline: Researcher → Auditor → Verifier → Designer → Coder
// (architect is legacy, merged into researcher Aug 21 2026)
const STEP_AGENTS: AgentRole[] = [
  'researcher',
  'auditor',
  'verifier',
  'designer',
  'coder',
];

export interface PipelineState {
  pipelineId: string | null;
  /** The project this run belongs to — what addresses its Tier 3 preview
   * container (`/api/preview/:projectId`). Arrives on `pipeline:context`,
   * which the SSE route sends before anything else, so it survives a reload. */
  projectId: string | null;
  currentStep: number;
  currentAgent: AgentRole | null;
  /**
   * Which model served each step, keyed by step number.
   *
   * The SSE route has always sent `model_used` on `step:start` and
   * `step:complete`; nothing read it. §3.4 asks the header to say which model
   * is serving the current stage, and this is where that comes from.
   *
   * Note that this channel is *not* verboseness-filtered — the stream is the
   * pipeline's own control channel and predates the setting. The header
   * therefore withholds the model below `verbose` as a display decision, so
   * that the two surfaces agree with each other and with §3.3's promise, even
   * though the value arrives here either way. See CLAUDE.md.
   */
  modelByStep: Record<number, string>;
  stepOutputs: Partial<Record<AgentRole, unknown>>;
  awaitingApproval: boolean;
  iteration: number;
  deploymentUrl: string | null;
  /** Set once the pipeline reaches `deployed` — the Coder's final file set,
   * for components/PreviewFrame.tsx. See routes/pipeline.ts's
   * pipeline:complete event, which looks these up from `generations`. */
  files: ProjectFile[];
  error: string | null;
  /**
   * The stage the run had reached when the error arrived.
   *
   * §3.4 requires an error to say "what failed, at which stage". The `error`
   * SSE event carries a message and no step, and by the time the view renders
   * it `currentStep` may have moved — so the stage is captured here, at the
   * moment the event is reduced, rather than read off live state later.
   */
  errorStep: number | null;
  /** True once `pipeline:complete` has arrived. Distinct from "the Coder
   * stage is current", which is also true while it is still writing files. */
  finished: boolean;
  /** When the run began, from the run's own row — see `pipeline:context`. A
   * clock started on mount would reset on every reload. */
  startedAt: string | null;
  connected: boolean;
}

function reduceEvents(
  pipelineId: string | null,
  events: PipelineEvent[],
  connected: boolean,
  projectId: string | null
): PipelineState {
  const state: PipelineState = {
    pipelineId,
    projectId,
    currentStep: 0,
    currentAgent: null,
    modelByStep: {},
    stepOutputs: {},
    awaitingApproval: false,
    iteration: 0,
    deploymentUrl: null,
    files: [],
    error: null,
    errorStep: null,
    finished: false,
    startedAt: null,
    connected,
  };

  for (const event of events) {
    if (event.type === 'pipeline:context') {
      // The stream is authoritative over whatever the client had stored: it
      // read the run's own row.
      if (event.projectId) state.projectId = event.projectId;
      if (event.startedAt) state.startedAt = event.startedAt;
    } else if (event.type === 'step:start' && event.step) {
      if (event.model) state.modelByStep[event.step] = event.model;
      state.currentStep = event.step;
      state.currentAgent = STEP_AGENTS[event.step - 1] ?? null;
      // Reaching the Coder step (or Design restarting after "Request
      // changes") means the gate already resolved server-side — routes/
      // pipeline.ts only ever sends gate:awaiting_approval once per visit
      // to that state, so nothing else clears this client-side and the
      // panel would otherwise stay open forever after Approve/Request
      // changes actually took effect.
      if (event.step === 4 || event.step === 5) state.awaitingApproval = false;
    } else if (event.type === 'step:complete' && event.step) {
      // Also advance currentStep on step:complete — when reconnecting to a
      // pipeline with completed steps, SSE only sends step:complete (not
      // step:start), so currentStep must be derived from completions too.
      if (event.model) state.modelByStep[event.step] = event.model;
      state.currentStep = Math.max(state.currentStep, event.step);
      state.currentAgent = STEP_AGENTS[event.step - 1] ?? null;
      const agent = STEP_AGENTS[event.step - 1];
      if (agent) state.stepOutputs[agent] = event.output;
    } else if (event.type === 'gate:awaiting_approval') {
      state.awaitingApproval = true;
    } else if (event.type === 'iteration:complete') {
      state.iteration = event.iteration ?? state.iteration;
      state.awaitingApproval = false;
    } else if (event.type === 'pipeline:complete') {
      state.deploymentUrl = event.deploymentUrl ?? null;
      state.files = event.files ?? [];
      // Also populate stepOutputs.coder — GenerationView reads files from
      // pipelineState.stepOutputs.coder.files, but the SSE route sends
      // iteration:complete (not step:complete) for the Coder step, so
      // stepOutputs.coder would otherwise never be set.
      state.stepOutputs.coder = { files: event.files ?? [] };
      state.awaitingApproval = false;
      state.finished = true;
    } else if (event.type === 'error') {
      state.error = event.message ?? event.error ?? 'Pipeline error';
      // Captured here, not read off live state at render time: `currentStep`
      // keeps moving, and an error attributed to the wrong stage is worse than
      // one attributed to none.
      state.errorStep = event.step ?? state.currentStep ?? null;
      // A run that errored is not a run that is still working. Leaving the
      // gate open would show approve/reject buttons for a pipeline that has
      // nothing left to advance.
      state.awaitingApproval = false;
    }
  }

  return state;
}

// Only a plain useState — no route param, localStorage, or rehydrate-on-mount
// logic — so navigating away from the Generation view (e.g. to Projects) and
// back always lost the in-progress run's id, even though pipeline_runs
// persists it server-side. The GET /api/pipeline/:id SSE route already
// replays full current state on a fresh connection (it derives events from
// current D1 row state each tick, not from a live-only push), so simply
// persisting/rehydrating this id client-side is sufficient to fix it.
const PIPELINE_ID_STORAGE_KEY = 'bicameral:activePipelineId';
// Stored alongside the run id for the same reason, and separately because the
// preview is addressed by project: `pipeline:context` re-supplies it a moment
// after the stream opens, but the first render after a reload happens before
// that, and starting the container is the slow step — asking for it a second
// earlier is the difference between a preview that is ready when the founder
// looks at it and one that is still booting.
const PROJECT_ID_STORAGE_KEY = 'bicameral:activeProjectId';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    // Ignore storage failures (private browsing, quota) — worst case this
    // reverts to the old lost-on-navigation behavior, not a hard failure.
  }
}

export function usePipeline() {
  const [pipelineId, setPipelineIdState] = useState<string | null>(() =>
    readStored(PIPELINE_ID_STORAGE_KEY)
  );
  const [projectId, setProjectIdState] = useState<string | null>(() =>
    readStored(PROJECT_ID_STORAGE_KEY)
  );
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const setPipelineId = useCallback((id: string | null) => {
    writeStored(PIPELINE_ID_STORAGE_KEY, id);
    setPipelineIdState(id);
  }, []);

  const setProjectId = useCallback((id: string | null) => {
    writeStored(PROJECT_ID_STORAGE_KEY, id);
    setProjectIdState(id);
  }, []);

  const streamUrl = pipelineId ? `/api/pipeline/${pipelineId}` : null;
  const { events, connected } = useGenerationStream(streamUrl);

  const pipelineState = useMemo(
    () => reduceEvents(pipelineId, events, connected, projectId),
    [pipelineId, events, connected, projectId]
  );

  // Persist whatever the stream reported, so the next reload has it before the
  // stream reconnects. Writing only on a real change keeps this out of the
  // render path for every unrelated event.
  useEffect(() => {
    if (pipelineState.projectId && pipelineState.projectId !== projectId) {
      setProjectId(pipelineState.projectId);
    }
  }, [pipelineState.projectId, projectId, setProjectId]);

  const startPipeline = useCallback(
    async (
      prompt: string,
      existingProjectId?: string,
      executionMode?: 'ask_first' | 'auto_accept'
    ) => {
      setBusy(true);
      setStartError(null);
      try {
        const response = await fetch('/api/pipeline', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            projectId: existingProjectId,
            executionMode,
          }),
        });
        if (!response.ok) {
          const body = (await response
            .json()
            .catch(() => ({ error: 'Failed to start pipeline' }))) as {
            error?: string;
          };
          throw new Error(body.error ?? 'Failed to start pipeline');
        }
        const data = (await response.json()) as {
          pipelineId: string;
          projectId?: string;
        };
        setPipelineId(data.pipelineId);
        // The route creates a project when the caller names none, so this is
        // always present now. It is optional in the type because an older
        // client/server pair may not agree, and losing the preview is better
        // than throwing away a started run.
        if (data.projectId) setProjectId(data.projectId);
        return data.pipelineId;
      } catch (err) {
        setStartError(
          err instanceof Error ? err.message : 'Failed to start pipeline'
        );
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [setPipelineId, setProjectId]
  );

  const approveBlueprint = useCallback(
    async (approved: boolean, feedback?: string) => {
      if (!pipelineId) return;
      await fetch(`/api/pipeline/${pipelineId}/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, feedback }),
      });
    },
    [pipelineId]
  );

  const cancelPipeline = useCallback(async () => {
    if (!pipelineId) return;
    await fetch(`/api/pipeline/${pipelineId}/cancel`, {
      method: 'POST',
      credentials: 'include',
    });
    // Previously left pipelineId set after a successful cancel, so the
    // textarea (gated on `!pipelineState.pipelineId` in GenerationView)
    // never came back — cancelling a pipeline was a dead end.
    setPipelineId(null);
    setProjectId(null);
  }, [pipelineId, setPipelineId, setProjectId]);

  // Deployed/errored runs previously had no way back to the prompt box —
  // pipelineId only ever got cleared by cancelPipeline, so finishing a
  // build was a dead end too, same as the cancel case above.
  const startNew = useCallback(() => {
    setPipelineId(null);
    // Cleared with the run: leaving it set would point the next preview at the
    // previous build's container.
    setProjectId(null);
  }, [setPipelineId, setProjectId]);

  return {
    pipelineState,
    startPipeline,
    approveBlueprint,
    cancelPipeline,
    startNew,
    busy,
    startError,
  };
}

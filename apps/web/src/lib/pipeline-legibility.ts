/**
 * What is happening, why, and what happens next — as data rather than as JSX.
 *
 * §3.4's test is that "a user watching the pipeline should be able to answer,
 * at any moment, *what is happening, why, and what happens next* — without
 * opening dev tools". Every sentence that answers one of those three questions
 * lives here, for two reasons.
 *
 * The first is that a component cannot be unit-tested in this repo's node
 * environment without dragging in a DOM, and the sentences are the part worth
 * pinning. The second is the one that actually bit: the running header used to
 * say `Researcher...` and nothing else — no stage number, no elapsed time, no
 * statement of what the run was waiting on — and the five-stage rail rendered
 * only on the *empty* screen, disappearing the moment a run started. The screen
 * was most legible when there was nothing to be legible about. That is not a
 * styling defect; it is a missing model of the run's state, so the model is
 * what this file adds.
 *
 * Nothing here formats a percentage. Progress is "stage 3 of 5", which is a
 * count of stages that have finished out of stages that exist, and a founder
 * can check it against the rail. "60% complete" would be the same number
 * wearing a claim about time it has no way to support.
 */

export const PIPELINE_AGENTS = [
  'researcher',
  'auditor',
  'verifier',
  'designer',
  'coder',
] as const;

export type PipelineAgent = (typeof PIPELINE_AGENTS)[number];

export interface StageDescription {
  agent: PipelineAgent;
  /** 1-based, matching `pipeline_steps.step_number`. */
  step: number;
  /** What the founder sees this stage called. */
  label: string;
  /** Why this stage exists — the "why" of §3.4's three questions. */
  purpose: string;
  /** Said while it is the running stage. */
  active: string;
}

export const PIPELINE_STAGES: StageDescription[] = [
  {
    agent: 'researcher',
    step: 1,
    label: 'Research',
    purpose: 'Finds what already exists and what your app has to account for.',
    active: 'Researching what your app has to account for',
  },
  {
    agent: 'auditor',
    step: 2,
    label: 'Audit',
    purpose:
      'A different model grades the research for gaps before anything is built on it.',
    active: 'Auditing the research for gaps',
  },
  {
    agent: 'verifier',
    step: 3,
    label: 'Verify',
    purpose: 'Checks the dependencies and constraints the plan assumes.',
    active: 'Checking dependencies and constraints',
  },
  {
    agent: 'designer',
    step: 4,
    label: 'Design',
    purpose: 'Writes the blueprint you approve before any code is generated.',
    active: 'Drafting the blueprint for your review',
  },
  {
    agent: 'coder',
    step: 5,
    label: 'Build',
    purpose: 'Generates the files, then fixes what its own checks find.',
    active: 'Generating and checking the files',
  },
];

export function stageFor(step: number): StageDescription | null {
  return PIPELINE_STAGES.find((stage) => stage.step === step) ?? null;
}

export function stageForAgent(agent: string): StageDescription | null {
  return PIPELINE_STAGES.find((stage) => stage.agent === agent) ?? null;
}

export type StageStatus = 'done' | 'active' | 'gate' | 'failed' | 'pending';

export interface RunSnapshot {
  currentStep: number;
  currentAgent: string | null;
  awaitingApproval: boolean;
  error: string | null;
  /** The stage the run had reached when the error arrived, if it errored. */
  errorStep?: number | null;
  finished: boolean;
  iteration?: number;
}

/**
 * The state of one stage in the rail.
 *
 * `gate` is its own status rather than a flavour of `active`, because a stage
 * that has stopped to ask a human is not a stage that is working, and a rail
 * that renders both as "in progress" tells the founder to wait when the thing
 * the run needs is them.
 */
export function stageStatuses(snapshot: RunSnapshot): StageStatus[] {
  return PIPELINE_STAGES.map((stage) => {
    if (snapshot.error && snapshot.errorStep === stage.step) return 'failed';
    if (snapshot.finished) return 'done';
    if (snapshot.awaitingApproval && snapshot.currentStep === stage.step) {
      return 'gate';
    }
    if (snapshot.currentStep > stage.step) return 'done';
    if (snapshot.currentStep === stage.step) return 'active';
    return 'pending';
  });
}

export interface WaitingOn {
  /** Who or what the run is waiting on. */
  subject: 'you' | 'pipeline' | 'nobody';
  /** One line, in the present tense, saying what is happening right now. */
  now: string;
  /** One line saying what happens after this — §3.4's "what happens next". */
  next: string;
}

/**
 * What the run is waiting on, said plainly.
 *
 * The `subject` field exists so the surface can tell the two apart without
 * re-parsing the sentence: a run waiting on the founder and a run waiting on a
 * model look identical in a spinner, and they are the two states a founder most
 * needs to distinguish. One of them ends when they act; the other does not end
 * any sooner for their watching it.
 */
export function waitingOn(snapshot: RunSnapshot): WaitingOn {
  if (snapshot.error) {
    const stage = snapshot.errorStep ? stageFor(snapshot.errorStep) : null;
    return {
      subject: 'you',
      now: stage ? `Stopped during ${stage.label}.` : 'The run stopped.',
      next: 'Nothing runs until you retry or start again.',
    };
  }

  if (snapshot.finished) {
    return {
      subject: 'nobody',
      now: 'The run finished.',
      next: 'Edit the files, or deploy what was built.',
    };
  }

  if (snapshot.awaitingApproval) {
    return {
      subject: 'you',
      now: 'Waiting for you to review the blueprint.',
      next: 'Approving it starts the build. Requesting changes sends it back to Design.',
    };
  }

  const stage = snapshot.currentAgent
    ? stageForAgent(snapshot.currentAgent)
    : stageFor(snapshot.currentStep);

  if (!stage) {
    return {
      subject: 'pipeline',
      now: 'Starting the run.',
      next: `${PIPELINE_STAGES[0].label} runs first.`,
    };
  }

  const iterating =
    stage.agent === 'coder' && (snapshot.iteration ?? 0) > 0
      ? ` (pass ${snapshot.iteration})`
      : '';

  const following = stageFor(stage.step + 1);
  const next =
    stage.agent === 'designer'
      ? 'It stops for your review before anything is built.'
      : following
        ? `${following.label} runs next — ${following.purpose.toLowerCase()}`
        : 'Your files appear in the tree as they are written.';

  return {
    subject: 'pipeline',
    now: `${stage.active}${iterating}.`,
    next,
  };
}

/** `4m 12s`, `47s`. Null in, null out — an unknown elapsed time is shown as
 * unknown rather than as zero, which would read as "just started". */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export interface ErrorReport {
  /** What failed, in four or five words. */
  headline: string;
  /** Which stage it failed at, or null if the run had not reached one. */
  stage: string | null;
  /** The underlying message, unmodified. */
  detail: string;
  /** What the founder can do about it. */
  remedy: string;
  /** Whether retrying is worth the founder's time. */
  retryable: boolean;
}

/**
 * Turn a raw pipeline error into the three things §3.4 requires: what failed,
 * at which stage, and what the user can do.
 *
 * The version this replaces rendered `{pipelineState.error}` into a red toast —
 * one string, no stage, no remedy, and it stayed on screen with no way to act
 * on it. The classification below is deliberately shallow: it keys off shapes
 * that actually appear in this pipeline's failures and falls through to a
 * generic-but-still-actionable report for everything else. A confident wrong
 * diagnosis is worse than "something failed at Design, here is the message,
 * here is the button".
 */
export function describePipelineError(
  message: string,
  step?: number | null
): ErrorReport {
  const stage = step ? stageFor(step) : null;
  const stageLabel = stage?.label ?? null;
  const at = stageLabel ? ` at the ${stageLabel} stage` : '';
  const lower = message.toLowerCase();

  if (/credit|quota|insufficient/.test(lower)) {
    return {
      headline: `The run stopped${at}: not enough credits.`,
      stage: stageLabel,
      detail: message,
      remedy:
        'Add credits, then start the run again. Nothing was charged for the stage that could not run.',
      retryable: false,
    };
  }

  if (/rate limit|429|too many requests/.test(lower)) {
    return {
      headline: `The model rate-limited this run${at}.`,
      stage: stageLabel,
      detail: message,
      remedy: 'Wait a minute and retry. Nothing about the prompt caused this.',
      retryable: true,
    };
  }

  if (/timeout|timed out|deadline/.test(lower)) {
    return {
      headline: `${stageLabel ?? 'A stage'} took too long and was stopped.`,
      stage: stageLabel,
      detail: message,
      remedy:
        'Retry. If it times out again, a shorter or more specific prompt usually finishes.',
      retryable: true,
    };
  }

  if (/unauthor|forbidden|401|403|session/.test(lower)) {
    return {
      headline: 'Your session is no longer valid.',
      stage: stageLabel,
      detail: message,
      remedy: 'Sign in again. The run is saved and will still be here.',
      retryable: false,
    };
  }

  if (/network|fetch failed|econn|disconnect/.test(lower)) {
    return {
      headline: `Lost the connection to the run${at}.`,
      stage: stageLabel,
      detail: message,
      remedy:
        'The run keeps going on the server. Reload to reconnect to it — you will not lose the stages that finished.',
      retryable: true,
    };
  }

  return {
    headline: stageLabel
      ? `The run failed at the ${stageLabel} stage.`
      : 'The run failed.',
    stage: stageLabel,
    detail: message,
    remedy:
      'Retry the run. If it fails the same way twice, the message above is what to send us — it names the stage.',
    retryable: true,
  };
}

export type PreviewTier = 'babel' | 'esbuild' | 'sandbox';

export interface TierDescription {
  label: string;
  /** What this tier is actually doing, as a claim a founder can check. */
  summary: string;
  /** What it cannot do — said out loud, because the silent version of this is
   * a preview that looks healthy while every API call in it fails. */
  limit: string | null;
}

/**
 * The three tiers as three visibly different things.
 *
 * §3.4: "The three preview tiers must be visibly different states, not a
 * spinner that sometimes takes 15 seconds." The header used to render
 * `Instant preview` / `Bundled preview` / `Full-stack preview` — three words
 * that differ only in the adjective, describing three genuinely different
 * machines. `limit` is the field that makes them different: the first two have
 * one and the third does not, which is the whole reason the third exists.
 */
export function describeTier(tier: PreviewTier): TierDescription {
  switch (tier) {
    case 'babel':
      return {
        label: 'Instant',
        summary: 'One file, compiled in your browser. No build step.',
        limit: 'Imports between your files and any API route will not run.',
      };
    case 'esbuild':
      return {
        label: 'Bundled',
        summary: 'Every file bundled in your browser and rendered together.',
        limit: 'There is no server, so API routes return nothing.',
      };
    case 'sandbox':
      return {
        label: 'Full-stack',
        summary:
          'A real dev server and your API server, running in a container.',
        limit: null,
      };
  }
}

export interface BackendEvidence {
  /** The route that was asked, e.g. `/api/todos`. */
  path: string;
  /** What it answered. */
  detail: string;
}

/**
 * The affirmative half of the Tier 3 health check.
 *
 * §3.4: 'After §3.2, Tier 3 means "a real backend is running" — say that, and
 * show the API route responding.' The health check already probes a declared
 * route and records what it answered, but the panel only ever rendered the
 * *unhealthy* probes. A working backend therefore looked exactly like a Tier 2
 * bundle: an iframe with nothing said about it. This returns the evidence so it
 * can be shown, which is the difference between claiming a backend is running
 * and showing the request that proves it.
 */
export function backendEvidence(
  probes: Array<{
    target: string;
    outcome: string;
    /** Null when no probeable route existed — see sandbox-health.ts, which
     * refuses to guess a value for a parameterised path like `/api/todos/:id`.
     * A probe with no path measured nothing, so it is not evidence. */
    path: string | null;
    detail: string;
  }>
): BackendEvidence | null {
  const probe = probes.find(
    (p) => p.target === 'backend' && p.outcome === 'healthy' && p.path
  );
  return probe?.path ? { path: probe.path, detail: probe.detail } : null;
}

/**
 * §3.4's three questions, asserted as questions rather than as pixels.
 *
 * "A user watching the pipeline should be able to answer, at any moment, what
 * is happening, why, and what happens next." Each describe block below is one
 * of those, plus the two surfaces §3.4 names specifically: the error report and
 * the three preview tiers.
 */
import { describe, it, expect } from 'vitest';
import {
  backendEvidence,
  describePipelineError,
  describeTier,
  formatElapsed,
  PIPELINE_AGENTS,
  PIPELINE_STAGES,
  stageFor,
  stageForAgent,
  stageStatuses,
  waitingOn,
  type RunSnapshot,
} from './pipeline-legibility.js';

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    currentStep: 1,
    currentAgent: 'researcher',
    awaitingApproval: false,
    error: null,
    finished: false,
    ...overrides,
  };
}

describe('the stages are the pipeline’s own stages', () => {
  it('names the five real agents in order', () => {
    // The flagship brief's §4 Phase 2 is explicit that the UI must not invent a
    // second vocabulary for these. This is the same rule applied inside the
    // product: one set of names, and they are the backend's.
    expect(PIPELINE_STAGES.map((s) => s.agent)).toEqual([...PIPELINE_AGENTS]);
    expect(PIPELINE_STAGES.map((s) => s.step)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives every stage a reason it exists', () => {
    // The "why" of the three questions. A rail of five nouns answers "what"
    // and nothing else.
    for (const stage of PIPELINE_STAGES) {
      expect(stage.purpose.length).toBeGreaterThan(20);
      expect(stage.active.length).toBeGreaterThan(10);
    }
  });

  it('never names an agent the pipeline does not have', () => {
    // "Architect" is legacy and merged into the researcher; the flagship brief
    // forbids it on a user-facing surface, as it does "bicameral".
    const text = JSON.stringify(PIPELINE_STAGES).toLowerCase();
    expect(text).not.toContain('architect');
    expect(text).not.toContain('bicameral');
    expect(text).not.toContain('critic');
  });

  it('reports no percentage anywhere', () => {
    // Progress is "stage 3 of 5" — a count against a denominator on screen.
    expect(JSON.stringify(PIPELINE_STAGES)).not.toContain('%');
  });

  it('looks a stage up by number and by agent', () => {
    expect(stageFor(4)?.label).toBe('Design');
    expect(stageForAgent('coder')?.step).toBe(5);
    expect(stageFor(9)).toBeNull();
    expect(stageForAgent('architect')).toBeNull();
  });
});

describe('what is happening — the rail', () => {
  it('marks finished stages done and the current one active', () => {
    expect(
      stageStatuses(run({ currentStep: 3, currentAgent: 'verifier' }))
    ).toEqual(['done', 'done', 'active', 'pending', 'pending']);
  });

  it('distinguishes a gate from work in progress', () => {
    // A stage that stopped to ask a human is not a stage that is working. A
    // rail rendering both as "in progress" tells the founder to wait when the
    // thing the run needs is them.
    const statuses = stageStatuses(
      run({ currentStep: 4, currentAgent: 'designer', awaitingApproval: true })
    );
    expect(statuses[3]).toBe('gate');
    expect(statuses).not.toContain('active');
  });

  it('marks the stage that failed rather than leaving it running forever', () => {
    const statuses = stageStatuses(
      run({
        currentStep: 2,
        currentAgent: 'auditor',
        error: 'boom',
        errorStep: 2,
      })
    );
    expect(statuses[1]).toBe('failed');
  });

  it('shows every stage done once the run finishes', () => {
    expect(stageStatuses(run({ currentStep: 5, finished: true }))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
  });
});

describe('what it is waiting on', () => {
  it('says the founder is the blocker at the gate, and says what each choice does', () => {
    const w = waitingOn(
      run({ currentStep: 4, currentAgent: 'designer', awaitingApproval: true })
    );
    expect(w.subject).toBe('you');
    expect(w.now).toContain('review the blueprint');
    expect(w.next).toContain('Approving');
    expect(w.next).toContain('Requesting changes');
  });

  it('says the pipeline is the blocker while an agent works', () => {
    // The distinction a spinner destroys: one of these states ends when the
    // founder acts, and the other does not end any sooner for their watching.
    const w = waitingOn(run({ currentStep: 1, currentAgent: 'researcher' }));
    expect(w.subject).toBe('pipeline');
    expect(w.now).toContain('Researching');
  });

  it('names the stage that runs next, with its reason', () => {
    const w = waitingOn(run({ currentStep: 2, currentAgent: 'auditor' }));
    expect(w.next).toContain('Verify');
    expect(w.next).toContain('dependencies');
  });

  it('warns that Design stops for a human, before it stops', () => {
    const w = waitingOn(run({ currentStep: 4, currentAgent: 'designer' }));
    expect(w.next).toContain('your review');
  });

  it('counts the Coder’s passes instead of hiding them', () => {
    // A build on its third self-repair pass is a different situation from one
    // on its first, and "Coding..." said both.
    const w = waitingOn(
      run({ currentStep: 5, currentAgent: 'coder', iteration: 3 })
    );
    expect(w.now).toContain('pass 3');
  });

  it('says nothing is waiting once the run finishes', () => {
    const w = waitingOn(run({ currentStep: 5, finished: true }));
    expect(w.subject).toBe('nobody');
    expect(w.next).toContain('deploy');
  });

  it('does not claim work is in progress after an error', () => {
    const w = waitingOn(
      run({
        currentStep: 3,
        currentAgent: 'verifier',
        error: 'x',
        errorStep: 3,
      })
    );
    expect(w.subject).toBe('you');
    expect(w.now).toContain('Verify');
    expect(w.next).toContain('until you');
  });

  it('handles the moment before the first stage starts', () => {
    const w = waitingOn(run({ currentStep: 0, currentAgent: null }));
    expect(w.now).toBe('Starting the run.');
    expect(w.next).toContain('Research');
  });
});

describe('elapsed time', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [47_000, '47s'],
    [60_000, '1m 0s'],
    [252_000, '4m 12s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });

  it('returns null for an unknown elapsed time rather than 0s', () => {
    // "0s" reads as "just started", which is a claim. Null renders as nothing.
    expect(formatElapsed(null)).toBeNull();
    expect(formatElapsed(undefined)).toBeNull();
    expect(formatElapsed(Number.NaN)).toBeNull();
    expect(formatElapsed(-5)).toBeNull();
  });
});

describe('errors say what failed, where, and what to do', () => {
  it('always produces all three, whatever the message', () => {
    // §3.4's requirement in full. The generic branch has to satisfy it too —
    // that is the branch most real failures land in.
    const report = describePipelineError('Something unexpected', 3);
    expect(report.headline).toContain('Verify');
    expect(report.stage).toBe('Verify');
    expect(report.detail).toBe('Something unexpected');
    expect(report.remedy.length).toBeGreaterThan(20);
  });

  it('keeps the raw message intact under the explanation', () => {
    // The explanation is added, never substituted: the message is the only
    // part a support conversation can act on.
    const raw = 'D1_ERROR: no such column: coverage_score';
    expect(describePipelineError(raw, 2).detail).toBe(raw);
  });

  it.each([
    ['insufficient credits remaining', 'credits', false],
    ['429 Too Many Requests', 'Wait a minute', true],
    ['Step timed out after 60s', 'shorter', true],
    ['401 Unauthorized', 'Sign in again', false],
    ['fetch failed: ECONNRESET', 'Reload', true],
  ])('gives %s a remedy that fits it', (message, needle, retryable) => {
    const report = describePipelineError(message, 4);
    expect(report.remedy).toContain(needle);
    expect(report.retryable).toBe(retryable);
  });

  it('does not invent a stage it was not given', () => {
    const report = describePipelineError('boom');
    expect(report.stage).toBeNull();
    expect(report.headline).toBe('The run failed.');
  });

  it('tells the founder a rate limit was not their prompt’s fault', () => {
    expect(describePipelineError('rate limit exceeded', 1).remedy).toContain(
      'Nothing about the prompt'
    );
  });
});

describe('the three preview tiers are three different things', () => {
  it('gives the client-side tiers an explicit limit and the container tier none', () => {
    // The limit field is what makes them different. Without it the three read
    // as one preview with three adjectives.
    expect(describeTier('babel').limit).toContain('API route');
    expect(describeTier('esbuild').limit).toContain('no server');
    expect(describeTier('sandbox').limit).toBeNull();
  });

  it('says of Tier 3 that a real server is running', () => {
    const t = describeTier('sandbox');
    expect(t.label).toBe('Full-stack');
    expect(t.summary).toContain('real dev server');
    expect(t.summary).toContain('container');
  });

  it('describes each tier by what it does, not by how long it takes', () => {
    // "not a spinner that sometimes takes 15 seconds" — no tier's identity is
    // a duration.
    for (const tier of ['babel', 'esbuild', 'sandbox'] as const) {
      expect(describeTier(tier).summary).not.toMatch(/second|fast|slow/i);
    }
  });
});

describe('showing the API route responding', () => {
  const probes = [
    {
      target: 'frontend',
      outcome: 'healthy',
      path: '/',
      detail: 'The dev server returned HTTP 200.',
    },
    {
      target: 'backend',
      outcome: 'healthy',
      path: '/api/todos',
      detail:
        '/api/todos returned HTTP 200 with a valid JSON body (142 bytes).',
    },
  ];

  it('returns the backend probe so the claim can be shown, not asserted', () => {
    const evidence = backendEvidence(probes);
    expect(evidence?.path).toBe('/api/todos');
    expect(evidence?.detail).toContain('HTTP 200');
  });

  it('does not offer the frontend probe as backend evidence', () => {
    // A dev server serving index.html is exactly what a running backend and a
    // dead one look like alike. See sandbox-health.ts's opening note.
    expect(backendEvidence([probes[0]])).toBeNull();
  });

  it('returns null when the backend probe failed', () => {
    expect(
      backendEvidence([{ ...probes[1], outcome: 'unhealthy' }])
    ).toBeNull();
  });

  it('returns null when nothing was probed at all', () => {
    // No measurement is not a passing measurement.
    expect(backendEvidence([])).toBeNull();
  });

  it('does not treat an unprobeable route as evidence', () => {
    // sandbox-health.ts returns a null path when every declared route is
    // parameterised, because it will not invent an id to probe with. That is
    // a probe that measured nothing, and nothing is not a running backend.
    expect(
      backendEvidence([
        {
          target: 'backend',
          outcome: 'healthy',
          path: null,
          detail: 'No parameter-free route to probe.',
        },
      ])
    ).toBeNull();
  });
});

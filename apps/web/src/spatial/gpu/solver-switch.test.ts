import { describe, expect, it } from 'vitest';

import {
  DEMOTE_PATIENCE_FRAMES,
  SOLVER_DEMOTE_MS,
  initialSolverSwitchState,
  observeSolveTime,
  solverChanged,
  type SolverSwitchState,
} from './solver-switch.js';

const run = (state: SolverSwitchState, ms: number, frames: number) => {
  let current = state;
  for (let i = 0; i < frames; i += 1) current = observeSolveTime(current, ms);
  return current;
};

const slow = SOLVER_DEMOTE_MS + 1;
const fast = SOLVER_DEMOTE_MS - 1;

describe('observeSolveTime', () => {
  it('holds SPH while frames stay under the threshold', () => {
    const after = run(initialSolverSwitchState('sph'), fast, 10_000);
    expect(after.solver).toBe('sph');
    expect(after.demoted).toBe(false);
  });

  it('demotes only after a sustained run of slow frames', () => {
    const start = initialSolverSwitchState('sph');
    const nearly = run(start, slow, DEMOTE_PATIENCE_FRAMES - 1);
    expect(nearly.solver).toBe('sph');
    expect(nearly.consecutiveSlowFrames).toBe(DEMOTE_PATIENCE_FRAMES - 1);

    const demoted = observeSolveTime(nearly, slow);
    expect(demoted.solver).toBe('mls-mpm');
    expect(demoted.demoted).toBe(true);
  });

  it('breaks the run on any single fast frame', () => {
    // The count is of *consecutive* slow frames on purpose: a machine that is
    // mostly fine and occasionally slow is not a machine that needs a different
    // solver, and switching it would cost a full pipeline rebuild for nothing.
    let state = run(
      initialSolverSwitchState('sph'),
      slow,
      DEMOTE_PATIENCE_FRAMES - 1
    );
    state = observeSolveTime(state, fast);
    expect(state.consecutiveSlowFrames).toBe(0);
    state = run(state, slow, DEMOTE_PATIENCE_FRAMES - 1);
    expect(state.solver).toBe('sph');
  });

  it('never demotes twice', () => {
    // Each switch rebuilds pipelines and reallocates buffers. A state that can
    // switch back is a state that can thrash, and the founder sees the fluid
    // change character every few seconds.
    const demoted = run(initialSolverSwitchState('sph'), slow, 10_000);
    expect(demoted.solver).toBe('mls-mpm');
    expect(run(demoted, slow, 10_000)).toEqual(demoted);
  });

  it('never promotes back to SPH', () => {
    const demoted = run(initialSolverSwitchState('sph'), slow, 10_000);
    expect(run(demoted, 0.1, 100_000).solver).toBe('mls-mpm');
  });

  it('does nothing when already on the cheap solver', () => {
    // MLS-MPM has nowhere to demote to. A machine that cannot hold it belongs
    // on the WebGL2 or static path, not on a third solver.
    const start = initialSolverSwitchState('mls-mpm');
    expect(run(start, slow, 10_000)).toEqual(start);
  });

  it('ignores a measurement that is not a usable number', () => {
    const start = initialSolverSwitchState('sph');
    for (const bad of [NaN, Infinity, -1]) {
      expect(observeSolveTime(start, bad)).toBe(start);
    }
  });

  it('does not count a run built out of garbage timestamps', () => {
    const after = run(initialSolverSwitchState('sph'), NaN, 10_000);
    expect(after.solver).toBe('sph');
    expect(after.consecutiveSlowFrames).toBe(0);
  });

  it('treats a frame exactly at the threshold as fast', () => {
    const state = observeSolveTime(
      initialSolverSwitchState('sph'),
      SOLVER_DEMOTE_MS
    );
    expect(state.consecutiveSlowFrames).toBe(0);
  });

  it('is pure', () => {
    const start = initialSolverSwitchState('sph');
    const snapshot = { ...start };
    observeSolveTime(start, slow);
    expect(start).toEqual(snapshot);
  });
});

describe('the demotion notice', () => {
  it('is absent until a demotion happens', () => {
    expect(initialSolverSwitchState('sph').reason).toBeNull();
  });

  it('says what changed and that it lasts the session', () => {
    const demoted = run(initialSolverSwitchState('sph'), slow, 10_000);
    expect(demoted.reason).toBeTruthy();
    expect(demoted.reason).toContain('session');
  });

  it('carries no percentage', () => {
    // Ground rule 2 — and a "30% slower" here would be a figure nothing in this
    // repo measured.
    const demoted = run(initialSolverSwitchState('sph'), slow, 10_000);
    expect(demoted.reason ?? '').not.toMatch(/\d\s*%|percent/i);
  });
});

describe('solverChanged', () => {
  it('is true only on the frame the switch happened', () => {
    const nearly = run(
      initialSolverSwitchState('sph'),
      slow,
      DEMOTE_PATIENCE_FRAMES - 1
    );
    const demoted = observeSolveTime(nearly, slow);
    expect(solverChanged(nearly, demoted)).toBe(true);
    expect(solverChanged(demoted, observeSolveTime(demoted, slow))).toBe(false);
    expect(solverChanged(nearly, nearly)).toBe(false);
  });
});

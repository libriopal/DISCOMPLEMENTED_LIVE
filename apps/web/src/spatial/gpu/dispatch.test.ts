import { describe, expect, it } from 'vitest';

import {
  FRAME_COMPUTE_BUDGET_MS,
  FRAME_RECOVER_MS,
  MAX_SUBSTEPS,
  MIN_PARTICLE_SCALE,
  MIN_SUBSTEPS,
  PANIC_MULTIPLIER,
  activeParticleCount,
  governFrame,
  initialBudgetState,
  isFloored,
  type BudgetState,
} from './dispatch.js';

/** Feed the governor the same measurement `frames` times. */
const run = (state: BudgetState, ms: number, frames: number): BudgetState => {
  let current = state;
  for (let i = 0; i < frames; i += 1) current = governFrame(current, ms);
  return current;
};

describe('the budget constants', () => {
  it('leaves a dead band between cutting and restoring', () => {
    // Without a gap the governor cuts at 4.0 and restores at 4.0, and a machine
    // sitting near the budget oscillates — which the founder sees as detail
    // flickering rather than as a machine at its limit.
    expect(FRAME_RECOVER_MS).toBeLessThan(FRAME_COMPUTE_BUDGET_MS);
  });

  it('sets the panic threshold well above the budget', () => {
    // The budget is a quality target; the panic cut is about the driver
    // watchdog, which resets the GPU rather than dropping a frame. They must
    // not be near enough to each other for ordinary jitter to trip the second.
    expect(PANIC_MULTIPLIER).toBeGreaterThan(1);
  });
});

describe('governFrame', () => {
  it('changes nothing while frames land inside the dead band', () => {
    const start = initialBudgetState();
    const after = run(
      start,
      (FRAME_COMPUTE_BUDGET_MS + FRAME_RECOVER_MS) / 2,
      200
    );
    expect(after.substeps).toBe(start.substeps);
    expect(after.particleScale).toBe(1);
  });

  it('waits before cutting, then cuts', () => {
    const start = initialBudgetState();
    // One slow frame must not cost quality: a garbage collection or a tab
    // regaining focus produces exactly this and is over by the next frame.
    expect(governFrame(start, 6).substeps).toBe(start.substeps);
    expect(run(start, 6, 60).substeps).toBeLessThan(start.substeps);
  });

  it('gives up substeps before particles', () => {
    // Substeps cost accuracy; particles cost the picture. The founder notices
    // the second one and not the first.
    // Long enough to spend every substep, short enough that particles have not
    // yet been reached — the window this ordering exists to create.
    const cut = run(initialBudgetState(), 6, 30);
    expect(cut.substeps).toBe(MIN_SUBSTEPS);
    expect(cut.particleScale).toBe(1);
  });

  it('reduces particles once substeps are at the floor', () => {
    const floored = run(initialBudgetState(), 6, 5000);
    expect(floored.substeps).toBe(MIN_SUBSTEPS);
    expect(floored.particleScale).toBeLessThan(1);
  });

  it('stops at the floor rather than reducing forever', () => {
    const floored = run(initialBudgetState(), 6, 100000);
    expect(floored.substeps).toBe(MIN_SUBSTEPS);
    expect(floored.particleScale).toBe(MIN_PARTICLE_SCALE);
    expect(isFloored(floored)).toBe(true);
  });

  it('restores in the reverse order it cut', () => {
    const floored = run(initialBudgetState(), 6, 100000);
    const recovering = run(floored, 0.5, 200);
    expect(recovering.particleScale).toBeGreaterThan(MIN_PARTICLE_SCALE);
    expect(recovering.substeps).toBe(MIN_SUBSTEPS);
  });

  it('never restores past where it started', () => {
    const recovered = run(initialBudgetState(), 0.1, 100000);
    expect(recovered.particleScale).toBe(1);
    expect(recovered.substeps).toBe(MAX_SUBSTEPS);
  });

  it('is far more patient about restoring than about cutting', () => {
    // Restoring into a machine that is only briefly idle is how the oscillation
    // starts from the other side.
    const cut = run(initialBudgetState(), 6, 60);
    const cutFrames = 60;
    const restored = run(cut, 0.5, cutFrames);
    expect(restored.substeps).toBe(cut.substeps);
  });

  it('cuts hard and immediately on a frame that risks a driver reset', () => {
    const start = initialBudgetState();
    const panicked = governFrame(
      start,
      FRAME_COMPUTE_BUDGET_MS * PANIC_MULTIPLIER + 1
    );
    expect(panicked.panicked).toBe(true);
    expect(panicked.substeps).toBeLessThan(start.substeps);
  });

  it('does not carry a panic measurement into the average', () => {
    // A 200 ms sample folded into the EMA would keep the governor cutting for
    // hundreds of frames after the cause — usually a backgrounded tab — is gone.
    const panicked = governFrame(initialBudgetState(), 500);
    expect(panicked.smoothedMs).toBe(FRAME_COMPUTE_BUDGET_MS);
  });

  it('ignores a measurement that is not a number', () => {
    // `measuredMs` comes from GPU timestamp queries, an optional feature that
    // returns garbage on some drivers rather than failing. A NaN in the average
    // makes every later comparison false and silently switches the governor off
    // — the one failure this module must not have.
    const start = initialBudgetState();
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      expect(governFrame(start, bad)).toEqual(start);
    }
  });

  it('survives a NaN arriving mid-session', () => {
    const cut = run(initialBudgetState(), 6, 60);
    const after = run(cut, NaN, 500);
    expect(Number.isFinite(after.smoothedMs)).toBe(true);
    expect(after).toEqual(cut);
  });

  it('is pure', () => {
    const start = initialBudgetState();
    const snapshot = { ...start };
    governFrame(start, 6);
    governFrame(start, 500);
    expect(start).toEqual(snapshot);
  });
});

describe('initialBudgetState', () => {
  it('seeds the average at the recovery threshold, not at zero', () => {
    // Seeded at 0 the first frames look like a machine with limitless headroom
    // and the governor promotes before anything has been measured.
    expect(initialBudgetState().smoothedMs).toBe(FRAME_RECOVER_MS);
  });

  it('clamps a caller-supplied substep count into range', () => {
    expect(initialBudgetState(99).substeps).toBe(MAX_SUBSTEPS);
    expect(initialBudgetState(0).substeps).toBe(MIN_SUBSTEPS);
    expect(initialBudgetState(-5).substeps).toBe(MIN_SUBSTEPS);
  });
});

describe('activeParticleCount', () => {
  it('scales the tier count', () => {
    const state = { ...initialBudgetState(), particleScale: 0.5 };
    expect(activeParticleCount(state, 65536)).toBe(32768);
  });

  it('is the full count at full scale', () => {
    expect(activeParticleCount(initialBudgetState(), 65536)).toBe(65536);
  });

  it('never dispatches zero particles', () => {
    // A zero dispatch is a frame that runs, costs nothing, and renders nothing
    // — indistinguishable from a hang by looking at it.
    const state = {
      ...initialBudgetState(),
      particleScale: MIN_PARTICLE_SCALE,
    };
    expect(activeParticleCount(state, 1)).toBeGreaterThan(0);
  });
});

describe('isFloored', () => {
  it('is false while anything is left to give up', () => {
    expect(isFloored(initialBudgetState())).toBe(false);
    expect(isFloored({ ...initialBudgetState(), substeps: MIN_SUBSTEPS })).toBe(
      false
    );
  });

  it('is true only when both are spent', () => {
    expect(
      isFloored({
        ...initialBudgetState(),
        substeps: MIN_SUBSTEPS,
        particleScale: MIN_PARTICLE_SCALE,
      })
    ).toBe(true);
  });
});

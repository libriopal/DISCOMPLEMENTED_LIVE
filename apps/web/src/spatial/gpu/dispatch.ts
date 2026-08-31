/**
 * The per-frame compute budget governor.
 *
 * The blueprint's number is 4.0 ms of compute dispatch per frame, and the
 * reason is not smoothness — it is that an operating system watchdog resets the
 * display driver when a single GPU submission runs too long (TDR on Windows,
 * the equivalent on macOS and Android). A reset does not drop a frame; it
 * destroys the device, takes every other tab's GPU context with it, and on
 * some drivers flashes the screen. So this is a safety limit that happens to
 * look like a performance knob, and it is enforced by *reducing work* rather
 * than by hoping.
 *
 * ## What it gives up, in order
 *
 * Substeps first, then particles. A solve with fewer substeps is the same
 * simulation integrated more coarsely — it looks slightly softer. A solve with
 * fewer particles is visibly a different fluid. Both are better than a driver
 * reset, but they are not equally bad, so the cheap one is spent first and the
 * expensive one only when substeps are already at the floor.
 *
 * ## Why there are two triggers and not one
 *
 * A smoothed average is the right instrument for "this machine is a bit slow" —
 * it ignores the single long frame that every browser produces during a GC or a
 * tab switch, and reacting to those would make the fluid pulse for reasons that
 * have nothing to do with the fluid. But an average is exactly the wrong
 * instrument for a watchdog: by the time a 200 ms frame has moved an average,
 * the reset has already happened. So a frame far over budget bypasses the
 * average entirely and cuts hard on the spot. The average protects quality; the
 * panic cut protects the device.
 */

/** Hard ceiling on compute dispatch per frame. See the module comment. */
export const FRAME_COMPUTE_BUDGET_MS = 4.0;

/**
 * Below this, the governor is allowed to give quality back. The gap between
 * this and the budget is deliberate dead space: recovering the moment we drop
 * under 4.0 ms would raise the work, exceed 4.0 ms, lower it again, and
 * oscillate forever at exactly the budget.
 */
export const FRAME_RECOVER_MS = 2.8;

/**
 * A frame this many times over budget is treated as an emergency rather than a
 * data point. Three is chosen to sit well clear of ordinary jitter — a 12 ms
 * compute frame is not a slow machine, it is something wrong.
 */
export const PANIC_MULTIPLIER = 3;

/** Weight of the newest sample in the moving average. */
const EMA_ALPHA = 0.15;

/** Frames over budget before the governor reduces work on the average. */
const OVER_BUDGET_PATIENCE = 8;

/** Frames comfortably under budget before it gives any back. */
const RECOVER_PATIENCE = 120;

export const MIN_SUBSTEPS = 1;
export const MAX_SUBSTEPS = 8;

/**
 * The floor on particle count, as a fraction of the tier's starting count.
 * Below an eighth the fluid stops reading as a fluid, and continuing to cut
 * would trade a recognisable simulation for a frame rate nobody asked for. A
 * machine that cannot hold budget at this floor is one the fallback path
 * should have taken (`fallback.ts`), and `isFloored` is how a caller finds out.
 */
export const MIN_PARTICLE_SCALE = 0.125;

export interface BudgetState {
  substeps: number;
  /** Fraction of the tier's initial particle count currently simulated. */
  particleScale: number;
  /** Exponential moving average of measured compute milliseconds. */
  smoothedMs: number;
  framesOverBudget: number;
  framesUnderRecover: number;
  /** Set once a frame exceeded `PANIC_MULTIPLIER` — sticky, for reporting. */
  panicked: boolean;
}

export function initialBudgetState(substeps = 4): BudgetState {
  return {
    substeps: clamp(substeps, MIN_SUBSTEPS, MAX_SUBSTEPS),
    particleScale: 1,
    // Seeded at the recovery threshold rather than 0, so the first few frames
    // cannot look like a machine with limitless headroom and trigger a
    // promotion before anything has actually been measured.
    smoothedMs: FRAME_RECOVER_MS,
    framesOverBudget: 0,
    framesUnderRecover: 0,
    panicked: false,
  };
}

/**
 * Fold one frame's measured compute time into the budget state.
 *
 * Pure, and total: every input including NaN produces a valid state. NaN is
 * worth calling out — `measuredMs` comes from GPU timestamp queries, which are
 * an optional feature and return garbage on some drivers rather than failing.
 * A NaN that propagated into `smoothedMs` would make every subsequent
 * comparison false and silently disable the governor, which is the one failure
 * this module must not have.
 */
export function governFrame(
  state: BudgetState,
  measuredMs: number
): BudgetState {
  if (!Number.isFinite(measuredMs) || measuredMs < 0) return state;

  if (measuredMs > FRAME_COMPUTE_BUDGET_MS * PANIC_MULTIPLIER) {
    return {
      ...reduceWork(state, /* hard */ true),
      // The average is reset to the budget, not to the measurement. Carrying a
      // 200 ms sample forward would keep the governor cutting for hundreds of
      // frames after the cause — usually a tab regaining focus — is gone.
      smoothedMs: FRAME_COMPUTE_BUDGET_MS,
      framesOverBudget: 0,
      framesUnderRecover: 0,
      panicked: true,
    };
  }

  const smoothedMs =
    state.smoothedMs + EMA_ALPHA * (measuredMs - state.smoothedMs);

  if (smoothedMs > FRAME_COMPUTE_BUDGET_MS) {
    const framesOverBudget = state.framesOverBudget + 1;
    if (framesOverBudget < OVER_BUDGET_PATIENCE) {
      return { ...state, smoothedMs, framesOverBudget, framesUnderRecover: 0 };
    }
    return {
      ...reduceWork(state, false),
      smoothedMs,
      framesOverBudget: 0,
      framesUnderRecover: 0,
    };
  }

  if (smoothedMs < FRAME_RECOVER_MS) {
    const framesUnderRecover = state.framesUnderRecover + 1;
    if (framesUnderRecover < RECOVER_PATIENCE) {
      return { ...state, smoothedMs, framesOverBudget: 0, framesUnderRecover };
    }
    return {
      ...restoreWork(state),
      smoothedMs,
      framesOverBudget: 0,
      framesUnderRecover: 0,
    };
  }

  // Inside the dead band: on budget, nothing to do.
  return { ...state, smoothedMs, framesOverBudget: 0, framesUnderRecover: 0 };
}

/** Substeps to the floor first, then particles. `hard` halves instead of steps. */
function reduceWork(state: BudgetState, hard: boolean): BudgetState {
  if (state.substeps > MIN_SUBSTEPS) {
    const substeps = hard
      ? Math.max(MIN_SUBSTEPS, Math.floor(state.substeps / 2))
      : state.substeps - 1;
    return { ...state, substeps };
  }
  const factor = hard ? 0.5 : 0.75;
  return {
    ...state,
    particleScale: Math.max(MIN_PARTICLE_SCALE, state.particleScale * factor),
  };
}

/** Give back in the reverse order it was taken: particles, then substeps. */
function restoreWork(state: BudgetState): BudgetState {
  if (state.particleScale < 1) {
    return {
      ...state,
      particleScale: Math.min(1, state.particleScale / 0.75),
    };
  }
  return {
    ...state,
    substeps: Math.min(MAX_SUBSTEPS, state.substeps + 1),
  };
}

/**
 * The governor has spent everything it has. A caller that is still over budget
 * here should switch solver (`solver-switch.ts`) or fall back, because
 * continuing to ask this module for headroom will not produce any.
 */
export function isFloored(state: BudgetState): boolean {
  return (
    state.substeps === MIN_SUBSTEPS && state.particleScale <= MIN_PARTICLE_SCALE
  );
}

/** Particles to actually dispatch this frame, given the tier's starting count. */
export function activeParticleCount(
  state: BudgetState,
  initialCount: number
): number {
  return Math.max(1, Math.floor(initialCount * state.particleScale));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

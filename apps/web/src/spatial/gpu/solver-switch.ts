/**
 * Demoting SPH to MLS-MPM when the machine turns out not to be the machine
 * `profile.ts` guessed.
 *
 * The blueprint's trigger is a sustained solve above 8.0 ms — twice the
 * dispatch budget in `dispatch.ts`, which is the point at which the governor is
 * visibly losing rather than merely working. Below that the governor handles
 * it by spending substeps and particles; above it, the solver itself is the
 * wrong shape for the hardware and no amount of scaling fixes that. SPH pays
 * for a neighbour search per particle; MLS-MPM scatters to a grid and skips the
 * sort entirely.
 *
 * ## The demotion is one-way, deliberately
 *
 * A symmetric rule would promote back to SPH the moment frames recovered, and
 * on a machine sitting near the threshold that is a loop: SPH is slow, demote,
 * MLS-MPM is fast, promote, SPH is slow. Each switch rebuilds pipelines and
 * reallocates buffers, so the thrash costs far more than either solver. Once a
 * session has evidence this hardware cannot hold SPH, that evidence does not
 * expire — the next reload gets a fresh guess, which is the right granularity
 * for a decision about a physical machine.
 *
 * This means `shouldDemote` can return true at most once per session, and
 * `SolverSwitchState.demoted` is the record of it.
 */

import type { Solver } from './profile.js';

/** Sustained milliseconds above which SPH is the wrong solver for this GPU. */
export const SOLVER_DEMOTE_MS = 8.0;

/**
 * Consecutive frames above the threshold before demoting.
 *
 * Long enough that a shader compile, a tab regaining focus, or one GC pause
 * cannot cost the founder the better solver; short enough that nobody watches
 * a stuttering fluid for a noticeable time before it improves. At 60 Hz this
 * is half a second.
 */
export const DEMOTE_PATIENCE_FRAMES = 30;

export interface SolverSwitchState {
  solver: Solver;
  consecutiveSlowFrames: number;
  /** Sticky. Once true, this session will not run SPH again. */
  demoted: boolean;
  /** Why, in a sentence, for the diagnostics panel. Null until demoted. */
  reason: string | null;
}

export function initialSolverSwitchState(solver: Solver): SolverSwitchState {
  return {
    solver,
    consecutiveSlowFrames: 0,
    demoted: false,
    reason: null,
  };
}

/**
 * Fold one frame's measured solve time into the switch state.
 *
 * Takes the raw measurement rather than the budget governor's smoothed average
 * on purpose: the governor smooths precisely so that quality does not react to
 * individual frames, and this decision wants the opposite — a run of genuinely
 * slow frames, counted, with the run broken by any fast one. Smoothing them
 * first would blur exactly the signal being counted.
 */
export function observeSolveTime(
  state: SolverSwitchState,
  measuredMs: number
): SolverSwitchState {
  // Already on the cheap solver, or already decided. Nothing above this can
  // change either, and MLS-MPM has nowhere to demote to — a machine that
  // cannot hold it belongs on the fallback path, not on a third solver.
  if (state.demoted || state.solver !== 'sph') return state;
  if (!Number.isFinite(measuredMs) || measuredMs < 0) return state;

  if (measuredMs <= SOLVER_DEMOTE_MS) {
    return state.consecutiveSlowFrames === 0
      ? state
      : { ...state, consecutiveSlowFrames: 0 };
  }

  const consecutiveSlowFrames = state.consecutiveSlowFrames + 1;
  if (consecutiveSlowFrames < DEMOTE_PATIENCE_FRAMES) {
    return { ...state, consecutiveSlowFrames };
  }

  return {
    solver: 'mls-mpm',
    consecutiveSlowFrames: 0,
    demoted: true,
    reason: `The particle solver ran over ${SOLVER_DEMOTE_MS} ms for ${DEMOTE_PATIENCE_FRAMES} frames in a row, so it switched to the grid-based solver for the rest of this session.`,
  };
}

/**
 * Whether the caller must rebuild its pipelines, given the state before and
 * after a fold. Compared rather than returned as a flag so that a caller which
 * drops a frame's state update cannot miss the one frame the switch happened
 * on.
 */
export function solverChanged(
  before: SolverSwitchState,
  after: SolverSwitchState
): boolean {
  return before.solver !== after.solver;
}

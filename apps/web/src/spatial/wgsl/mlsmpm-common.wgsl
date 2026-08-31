// Prelude for the three MLS-MPM passes, composed after `common.wgsl` in
// `gpu/shaders.ts`. The grid bindings and the fixed-point encoding live here
// rather than in each pass for the same reason the particle struct lives in
// `common.wgsl`: p2g writes what grid reads and g2p reads what grid wrote, so a
// scale constant that differed between two of them would produce a fluid that
// is merely the wrong density, with nothing to point at.
//
// ## Why the grid is integers
//
// Scattering means many particles adding into the same cell, which needs
// atomics, and WGSL has atomics for i32 and u32 and not for f32. So mass and
// momentum accumulate in fixed point and are decoded in `mlsmpm-grid.wgsl`.
//
// The scale is the same idea as `game/determinism/fixed-point.ts` in
// Glassbox_Labs, at a larger value because this quantises physical mass rather
// than game state. It is a genuine trade and worth stating plainly: too small a
// scale and light particles quantise to zero and vanish from the grid; too
// large and a dense cell overflows i32 and wraps to a *negative* mass, which
// renders as the fluid violently inverting. 1e4 leaves four decimal digits of
// mass resolution and headroom for far more contributions in one cell than
// `MIN_PARTICLE_SCALE` can put there.
//
// This is also the honest answer to the blueprint's cross-device determinism
// claim. Fixed point makes each *addition* exact, but atomics do not fix the
// *order* of those additions, and the float-to-fixed rounding happens before
// the atomic. Two GPUs agree far more closely than they would in float, and
// they do not agree bitwise. G6 in the plan is why the CRDT is authoritative
// over synchronised state rather than the local solve.

const MPM_FIXED_SCALE: f32 = 10000.0;

@group(1) @binding(0) var<storage, read_write> gridMass: array<atomic<i32>>;
@group(1) @binding(1) var<storage, read_write> gridMomentum: array<atomic<i32>>;
@group(1) @binding(2) var<storage, read_write> particleAffine: array<mat3x3<f32>>;

fn encodeFixed(value: f32) -> i32 {
  // Clamped short of i32's range so a diverged particle contributes a large
  // number rather than a wrapped negative one. A saturated cell looks wrong; a
  // wrapped cell looks like the simulation exploded.
  return i32(clamp(value * MPM_FIXED_SCALE, -2.0e9, 2.0e9));
}

fn decodeFixed(value: i32) -> f32 {
  return f32(value) / MPM_FIXED_SCALE;
}

// Quadratic B-spline weights over the three cells nearest along each axis.
// Component `.x` of entry `i` is the weight for x-offset `i`, and likewise for
// y and z — so the three-deep loop in p2g and g2p reads `w[gx].x * w[gy].y *
// w[gz].z`.
//
// Quadratic rather than cubic: cubic needs a four-cell stencil per axis, so 64
// cells instead of 27, for a smoothness that is not visible at the particle
// counts the tiers running this solver actually reach.
fn bsplineWeights(fx: vec3<f32>) -> array<vec3<f32>, 3> {
  let a = 0.5 * (1.5 - fx) * (1.5 - fx);
  let b = 0.75 - (fx - 1.0) * (fx - 1.0);
  let c = 0.5 * (fx - 0.5) * (fx - 0.5);
  return array<vec3<f32>, 3>(a, b, c);
}

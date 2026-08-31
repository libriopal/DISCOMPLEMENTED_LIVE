// Position integration and domain boundaries. Shared by both solvers — SPH and
// MLS-MPM disagree about how a velocity is produced and agree completely about
// what to do with one.
//
// Semi-implicit (symplectic) Euler: the velocity is already this frame's when
// the position uses it, which is the difference between a bounded oscillation
// and one that gains energy every step. Explicit Euler is one character
// different here and diverges on any spring-like interaction, which is what
// SPH pressure is.

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount) { return; }

  var velocity = particles[i].velocity;
  var position = particles[i].position + velocity * params.dt;

  // The domain is the hash grid. A particle outside it clamps to a cell on the
  // boundary (see `cellIndex`), so letting one drift away would leave it in a
  // cell it is not near, dragging on a neighbour list it does not belong to.
  // Bouncing it back is cheaper than special-casing that everywhere else.
  let lower = params.gridMin;
  let upper = params.gridMin + vec3<f32>(params.gridDim) * params.cellSize;

  // Restitution below 1: a perfectly elastic wall adds no energy in theory and
  // does in floating point, because the reflection happens after the particle
  // has already been pushed past the wall by the pressure that put it there.
  let restitution = 0.4;

  if (position.x < lower.x) { position.x = lower.x; velocity.x = abs(velocity.x) * restitution; }
  if (position.y < lower.y) { position.y = lower.y; velocity.y = abs(velocity.y) * restitution; }
  if (position.z < lower.z) { position.z = lower.z; velocity.z = abs(velocity.z) * restitution; }
  if (position.x > upper.x) { position.x = upper.x; velocity.x = -abs(velocity.x) * restitution; }
  if (position.y > upper.y) { position.y = upper.y; velocity.y = -abs(velocity.y) * restitution; }
  if (position.z > upper.z) { position.z = upper.z; velocity.z = -abs(velocity.z) * restitution; }

  // The position clamp uses the domain extent as its magnitude limit rather
  // than maxSpeed: a NaN position sanitises to the origin, and the boundary
  // logic above cannot rescue a coordinate that was never a number.
  let extent = length(vec3<f32>(params.gridDim) * params.cellSize) + length(params.gridMin);
  particles[i].position = sanitizeVec3(position, extent);
  particles[i].velocity = sanitizeVec3(velocity, params.maxSpeed);
}

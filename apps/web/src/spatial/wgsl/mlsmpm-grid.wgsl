// MLS-MPM pass 2 — the grid update.
//
// One invocation per cell, no atomics and no neighbours: divide the
// accumulated momentum by the accumulated mass to recover a velocity, apply
// gravity, and enforce the domain walls. This is where MPM handles collision,
// and handling it on the grid rather than per particle is most of why the
// method is cheap — a wall is a condition on a few hundred boundary cells
// instead of a test every particle runs.
//
// The result is written back into `gridMomentum` as a *velocity* in fixed
// point, which g2p then reads. Reusing the buffer rather than allocating a
// third one is the same trade as `cellCounts` in `spatial-hash.wgsl`: the
// momentum is dead the moment it has been divided, and at these cell counts
// the saved allocation is real memory.

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x;
  if (cell >= cellCount()) { return; }

  let mass = decodeFixed(atomicLoad(&gridMass[cell]));

  // An empty cell is the common case — most of the grid is not fluid — and
  // dividing by its zero mass is the single most likely source of NaN in this
  // solver. The threshold is not merely > 0: a cell holding one quantisation
  // step of mass produces a velocity of momentum/epsilon, which is finite,
  // enormous, and worse than nothing.
  if (mass <= 1.0 / MPM_FIXED_SCALE) {
    atomicStore(&gridMomentum[cell * 3u + 0u], 0);
    atomicStore(&gridMomentum[cell * 3u + 1u], 0);
    atomicStore(&gridMomentum[cell * 3u + 2u], 0);
    return;
  }

  var velocity = vec3<f32>(
    decodeFixed(atomicLoad(&gridMomentum[cell * 3u + 0u])),
    decodeFixed(atomicLoad(&gridMomentum[cell * 3u + 1u])),
    decodeFixed(atomicLoad(&gridMomentum[cell * 3u + 2u])),
  ) / mass;

  velocity = velocity + params.gravity * params.dt;

  // Boundary cells: velocity is zeroed on the component pointing out of the
  // domain and kept on the others, which is a slip wall. Zeroing all three
  // would be a no-slip wall and would glue the fluid to the box.
  let dim = params.gridDim;
  let z = cell / (dim.x * dim.y);
  let y = (cell - z * dim.x * dim.y) / dim.x;
  let x = cell - z * dim.x * dim.y - y * dim.x;

  if (x == 0u && velocity.x < 0.0) { velocity.x = 0.0; }
  if (y == 0u && velocity.y < 0.0) { velocity.y = 0.0; }
  if (z == 0u && velocity.z < 0.0) { velocity.z = 0.0; }
  if (x >= dim.x - 1u && velocity.x > 0.0) { velocity.x = 0.0; }
  if (y >= dim.y - 1u && velocity.y > 0.0) { velocity.y = 0.0; }
  if (z >= dim.z - 1u && velocity.z > 0.0) { velocity.z = 0.0; }

  // G5: sanitised before it is written, because every particle in the stencil
  // around this cell reads it next pass. One diverged cell reaching g2p
  // unchecked becomes 27 diverged particles, and next frame their stencils
  // overlap further still.
  let safe = sanitizeVec3(velocity, params.maxSpeed);

  atomicStore(&gridMomentum[cell * 3u + 0u], encodeFixed(safe.x));
  atomicStore(&gridMomentum[cell * 3u + 1u], encodeFixed(safe.y));
  atomicStore(&gridMomentum[cell * 3u + 2u], encodeFixed(safe.z));
}

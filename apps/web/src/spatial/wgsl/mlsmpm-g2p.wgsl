// MLS-MPM pass 3 — the grid velocities are gathered back onto the particles,
// along with the affine field APIC needs to carry rotation across the transfer.
//
// The affine matrix `C` is the least-squares fit of the grid velocities around
// the particle to a linear field. Recomputing it every frame is what makes the
// method "moving least squares" and is the difference between a vortex that
// persists and one that diffuses away over a few seconds — the same information
// that the plain PIC transfer throws away and that FLIP recovers by keeping a
// noisy velocity difference instead.
//
// The `4 / cellSize` factor is the inverse of the quadratic B-spline's second
// moment. It is a property of the kernel chosen in `mlsmpm-common.wgsl` and not
// a tunable: changing to a cubic spline changes this constant too, and changing
// one without the other produces a fluid that looks plausible and conserves
// nothing.
//
// This pass deliberately does *not* move the particles. Position integration
// and the domain walls stay in `integrate.wgsl`, shared with SPH, so there is
// one place where a particle's position is written and one boundary behaviour
// for both solvers. A demotion mid-session must not change how the fluid meets
// the walls.

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount) { return; }

  let gridPos = (particles[i].position - params.gridMin) / params.cellSize;
  let base = vec3<i32>(gridPos - 0.5);
  let fx = gridPos - vec3<f32>(base);
  let w = bsplineWeights(fx);

  var velocity = vec3<f32>(0.0, 0.0, 0.0);
  var affine = mat3x3<f32>(
    vec3<f32>(0.0, 0.0, 0.0),
    vec3<f32>(0.0, 0.0, 0.0),
    vec3<f32>(0.0, 0.0, 0.0),
  );

  for (var gx: i32 = 0; gx < 3; gx = gx + 1) {
    for (var gy: i32 = 0; gy < 3; gy = gy + 1) {
      for (var gz: i32 = 0; gz < 3; gz = gz + 1) {
        let weight = w[gx].x * w[gy].y * w[gz].z;
        let coord = base + vec3<i32>(gx, gy, gz);
        let cell = cellIndex(coord);

        let cellVelocity = vec3<f32>(
          decodeFixed(atomicLoad(&gridMomentum[cell * 3u + 0u])),
          decodeFixed(atomicLoad(&gridMomentum[cell * 3u + 1u])),
          decodeFixed(atomicLoad(&gridMomentum[cell * 3u + 2u])),
        );

        let offset = (vec3<f32>(coord) + 0.5 - gridPos) * params.cellSize;
        let weighted = weight * cellVelocity;

        velocity = velocity + weighted;

        // Outer product of the weighted velocity with the offset, accumulated
        // column by column because WGSL has no outer-product operator.
        affine[0] = affine[0] + weighted * offset.x;
        affine[1] = affine[1] + weighted * offset.y;
        affine[2] = affine[2] + weighted * offset.z;
      }
    }
  }

  let inverseMoment = 4.0 / (params.cellSize * params.cellSize);

  particles[i].velocity = sanitizeVec3(velocity, params.maxSpeed);

  // The affine field is bounded on the same principle as velocity, at the
  // gradient scale rather than the speed scale: a matrix column is a velocity
  // *difference per unit length*, so its natural limit is maxSpeed over a cell.
  // Left unbounded it is the fastest path to divergence in this solver — it
  // multiplies the offset in p2g, so an inflated C feeds back into the momentum
  // that produced it, and the growth is exponential rather than linear.
  let affineLimit = params.maxSpeed / params.cellSize;
  particleAffine[i] = mat3x3<f32>(
    sanitizeVec3(affine[0] * inverseMoment, affineLimit),
    sanitizeVec3(affine[1] * inverseMoment, affineLimit),
    sanitizeVec3(affine[2] * inverseMoment, affineLimit),
  );

  // The particle keeps a density for the renderer's benefit only — this solver
  // does not compute one, and the grid's mass is the closest true equivalent.
  // Left at whatever SPH last wrote, a demoted session would colour particles
  // by a density that stopped updating at the moment of the switch.
  particles[i].density = params.restDensity;
  particles[i].pressure = 0.0;
}

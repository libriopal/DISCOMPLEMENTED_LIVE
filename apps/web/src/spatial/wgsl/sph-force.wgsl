// SPH pass 2 — pressure, viscosity and gravity, accumulated into velocity.
//
// Split from the density pass rather than fused into it because every
// particle's force reads its neighbours' *densities*, and those are only
// complete once the density dispatch has finished for all of them. Fusing the
// two would read whatever a neighbour's density happened to be — last frame's
// for particles not yet processed, this frame's for the rest — which produces
// a fluid that is stable, plausible, and wrong, and wrong in a way no visual
// inspection catches.
//
// The pressure term is symmetrised as (p_i + p_j) / 2 so that the force
// particle i exerts on j equals the force j exerts on i. The unsymmetrised
// form is cheaper and violates Newton's third law: momentum leaks, and a
// closed volume of fluid slowly accelerates in whatever direction its density
// gradient happens to favour.

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount) { return; }

  let self = particles[i];
  let base = cellCoord(self.position);
  let h = params.smoothingRadius;

  var force = vec3<f32>(0.0, 0.0, 0.0);

  for (var dz: i32 = -1; dz <= 1; dz = dz + 1) {
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        let cell = cellIndex(base + vec3<i32>(dx, dy, dz));
        let start = cellOffsets[cell];
        let end = start + atomicLoad(&cellCounts[cell]);

        for (var s: u32 = start; s < end; s = s + 1u) {
          let j = sortedIndices[s];
          if (j == i) { continue; }

          let other = particles[j];
          let d = self.position - other.position;
          let r = length(d);
          if (r <= 0.0 || r >= h) { continue; }

          let dir = d / r;

          force = force + dir * (
            -params.particleMass
            * ((self.pressure + other.pressure) / (2.0 * other.density))
            * spikyGradient(r, h)
          );

          force = force + (other.velocity - self.velocity) * (
            params.viscosity * params.particleMass
            / other.density * viscosityLaplacian(r, h)
          );
        }
      }
    }
  }

  let acceleration = force / self.density + params.gravity;

  // Sanitised at the write, not at the read. Anything that leaves this pass is
  // read by the integrator and by next frame's neighbour search, so this is the
  // boundary where a diverged value stops being one particle's problem and
  // starts being every nearby particle's. See the G5 note in common.wgsl.
  particles[i].velocity = sanitizeVec3(
    self.velocity + acceleration * params.dt,
    params.maxSpeed,
  );
}

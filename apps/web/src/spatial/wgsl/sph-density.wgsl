// SPH pass 1 — density and pressure.
//
//   rho_i = sum_j m_j * W(r_i - r_j, h)      (Müller et al. 2003, poly6)
//   p_i   = k * (rho_i - rho_0)              (Tait, linearised)
//
// The linear equation of state rather than the exponential form: the
// exponential is stiffer and holds incompressibility better, but it needs a
// smaller timestep to stay stable, and a smaller timestep costs substeps —
// which is the first thing `dispatch.ts` takes away under budget pressure. A
// solver whose stability depends on the quantity the governor is allowed to
// reduce will diverge precisely on the machines that can least afford it.
//
// The 27-cell neighbourhood is fixed because `cellSize == smoothingRadius`, so
// no particle within h can be more than one cell away on any axis. That
// invariant is asserted in `bindings.ts` when the grid is built; if it were
// ever violated the loop below would silently miss neighbours and the fluid
// would read as merely "too compressible" rather than as a bug.

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount) { return; }

  let position = particles[i].position;
  let base = cellCoord(position);
  let h = params.smoothingRadius;

  var density: f32 = 0.0;

  for (var dz: i32 = -1; dz <= 1; dz = dz + 1) {
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        let cell = cellIndex(base + vec3<i32>(dx, dy, dz));
        let start = cellOffsets[cell];
        let end = start + atomicLoad(&cellCounts[cell]);

        for (var s: u32 = start; s < end; s = s + 1u) {
          let j = sortedIndices[s];
          let d = position - particles[j].position;
          density = density + params.particleMass * poly6(dot(d, d), h);
        }
      }
    }
  }

  // A particle always contributes to its own density, so the floor is that
  // self-contribution rather than zero. A density of zero divides by zero in
  // the force pass; poly6(0, h) is the smallest value that is physically
  // meaningful here and it costs one max().
  let selfDensity = params.particleMass * poly6(0.0, h);
  density = max(sanitizeScalar(density, selfDensity, 1.0e9), selfDensity);

  particles[i].density = density;
  particles[i].pressure = sanitizeScalar(
    params.stiffness * (density - params.restDensity),
    0.0,
    1.0e9,
  );
}

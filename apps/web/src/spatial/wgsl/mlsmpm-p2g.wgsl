// MLS-MPM pass 1 — particles scatter mass and momentum onto the background
// grid (APIC transfer; Jiang et al. 2015, Hu et al. 2018).
//
// This is the solver the integrated and mobile tiers start on and the one SPH
// demotes to. It is cheaper for one structural reason: there is no neighbour
// search. Each particle touches a fixed 27-cell stencil around itself and the
// grid does the coupling, so the counting sort in `spatial-hash.wgsl` and all
// three `prefix-sum` passes are skipped, along with the entire sorted-index
// buffer's traffic.
//
// The fixed-point encoding this pass writes through is explained in
// `mlsmpm-common.wgsl`.

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount) { return; }

  let p = particles[i];
  let gridPos = (p.position - params.gridMin) / params.cellSize;
  let base = vec3<i32>(gridPos - 0.5);
  let fx = gridPos - vec3<f32>(base);
  let w = bsplineWeights(fx);

  let mass = params.particleMass;
  let affine = particleAffine[i];

  for (var gx: i32 = 0; gx < 3; gx = gx + 1) {
    for (var gy: i32 = 0; gy < 3; gy = gy + 1) {
      for (var gz: i32 = 0; gz < 3; gz = gz + 1) {
        let weight = w[gx].x * w[gy].y * w[gz].z;
        let coord = base + vec3<i32>(gx, gy, gz);
        let cell = cellIndex(coord);

        // APIC: the particle carries an affine velocity field, so the momentum
        // it hands a cell includes what that field predicts at the cell's
        // offset. This is what stops MPM shedding angular momentum and turning
        // a vortex into a slowly dissolving blob.
        let offset = (vec3<f32>(coord) + 0.5 - gridPos) * params.cellSize;
        let momentum = mass * (p.velocity + affine * offset);

        atomicAdd(&gridMass[cell], encodeFixed(weight * mass));
        atomicAdd(&gridMomentum[cell * 3u + 0u], encodeFixed(weight * momentum.x));
        atomicAdd(&gridMomentum[cell * 3u + 1u], encodeFixed(weight * momentum.y));
        atomicAdd(&gridMomentum[cell * 3u + 2u], encodeFixed(weight * momentum.z));
      }
    }
  }
}

// Zeroed by dispatch rather than by uploading a zero-filled staging buffer:
// the grid runs to hundreds of thousands of cells and writing that much zero
// across the bus every frame is bandwidth spent communicating nothing.
@compute @workgroup_size(256)
fn clearGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= cellCount()) { return; }
  atomicStore(&gridMass[i], 0);
  atomicStore(&gridMomentum[i * 3u + 0u], 0);
  atomicStore(&gridMomentum[i * 3u + 1u], 0);
  atomicStore(&gridMomentum[i * 3u + 2u], 0);
}

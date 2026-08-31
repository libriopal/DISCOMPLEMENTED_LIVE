// Shared prelude for every compute pass. Prepended in `gpu/shaders.ts`, since
// WGSL has no include directive and duplicating a struct layout across nine
// files is how a padding byte goes wrong in exactly one of them.
//
// The bindings below are declared here in full even though no single pass uses
// all of them. That is safe only because the pipelines use an explicit
// GPUBindGroupLayout rather than layout: 'auto' — auto layout is derived from
// what an entry point *statically uses*, so it would silently produce a
// different layout per pass and every bind group would then mismatch on some
// of them. See `gpu/bindings.ts`, which is the one place the layout is written.

struct SimParams {
  gridMin: vec3<f32>,          // world-space corner of the hash grid
  cellSize: f32,               // == smoothingRadius, so a cell holds one kernel
  gridDim: vec3<u32>,
  particleCount: u32,          // active count this frame; see dispatch.ts
  gravity: vec3<f32>,
  dt: f32,
  restDensity: f32,
  stiffness: f32,              // Tait equation-of-state coefficient
  viscosity: f32,
  smoothingRadius: f32,
  maxSpeed: f32,               // the clamp that keeps a blown-up solve bounded
  particleMass: f32,
  _pad0: f32,
  _pad1: f32,
}

// 32 bytes, and the field order is the packing: vec3 aligns to 16 in WGSL, so
// the two scalars ride in the padding that would otherwise be wasted. This
// struct is also the vertex layout for the instanced billboard draw — the
// buffer is STORAGE | VERTEX and is never mapped back to the CPU, which is the
// whole zero-readback design. Changing a field here changes that vertex layout
// too; `bindings.ts` holds the matching stride and `shader-contract.test.ts`
// pins them against each other.
struct Particle {
  position: vec3<f32>,
  density: f32,
  velocity: vec3<f32>,
  pressure: f32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> cellCounts: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellOffsets: array<u32>;
@group(0) @binding(4) var<storage, read_write> sortedIndices: array<u32>;
@group(0) @binding(5) var<storage, read_write> particleCellIds: array<u32>;

// ---------------------------------------------------------------------------
// G5: the zero-readback invariant, enforced here
// ---------------------------------------------------------------------------
//
// The blueprint asks for two things that cannot both be true: a rendering loop
// that never reads GPU memory back to the CPU, and a CPU worker that inspects
// particle state for NaNs and velocity explosions. If the CPU never reads the
// buffer, that worker has nothing to inspect.
//
// Option A was chosen: the check moves onto the GPU and happens here, so the
// invariant holds and no readback is needed to keep the simulation bounded.
// Every write of a position or a velocity goes through `sanitizeVec3`, and
// every write of a density or pressure through `sanitizeScalar`.
//
// This is containment, not detection: it stops a diverged solve from
// propagating NaN through the neighbour search into every particle that reads
// it, and it stops an unbounded velocity from throwing particles far enough
// out of the grid to make the hash meaningless. It does not report that
// divergence happened — that is the opt-in debug sampling pass, which is the
// only thing in the engine that reads back, and which is off by default.

fn sanitizeScalar(value: f32, fallback: f32, limit: f32) -> f32 {
  // A NaN fails every comparison, including against itself, so this ordering
  // matters: the `value != value` test is the only one that catches it, and
  // writing it as `if (value == value)` inverted would let NaN through the
  // else branch of a clamp.
  if (value != value) { return fallback; }
  return clamp(value, -limit, limit);
}

fn sanitizeVec3(v: vec3<f32>, limit: f32) -> vec3<f32> {
  let safe = vec3<f32>(
    select(0.0, v.x, v.x == v.x),
    select(0.0, v.y, v.y == v.y),
    select(0.0, v.z, v.z == v.z),
  );
  // Clamped by magnitude rather than per-component: clamping each axis
  // separately changes the direction of the vector, which turns a too-fast
  // particle into a particle moving somewhere else. Speed is the quantity the
  // budget cares about; direction is the quantity the simulation cares about.
  let lengthSq = dot(safe, safe);
  if (lengthSq > limit * limit && lengthSq > 0.0) {
    return safe * (limit / sqrt(lengthSq));
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Spatial hashing
// ---------------------------------------------------------------------------

fn cellCoord(position: vec3<f32>) -> vec3<i32> {
  return vec3<i32>(floor((position - params.gridMin) / params.cellSize));
}

// Cells outside the grid clamp to the boundary rather than wrapping. Wrapping
// would make a particle that escaped the domain a neighbour of one on the far
// side, which reads as fluid teleporting — a rare, unreproducible artefact
// that is very hard to attribute back to the hash.
fn cellIndex(coord: vec3<i32>) -> u32 {
  let dim = vec3<i32>(params.gridDim);
  let c = clamp(coord, vec3<i32>(0), dim - vec3<i32>(1));
  return u32(c.x) + u32(c.y) * params.gridDim.x
       + u32(c.z) * params.gridDim.x * params.gridDim.y;
}

fn cellCount() -> u32 {
  return params.gridDim.x * params.gridDim.y * params.gridDim.z;
}

// ---------------------------------------------------------------------------
// SPH kernels (Müller et al. 2003), normalised for 3D
// ---------------------------------------------------------------------------

const PI: f32 = 3.14159265359;

// Poly6, used for density only. Its gradient vanishes at r = 0, which is why
// it is not used for pressure — particles at the same position would feel no
// force from each other and clump permanently.
fn poly6(rSq: f32, h: f32) -> f32 {
  let hSq = h * h;
  if (rSq >= hSq) { return 0.0; }
  let diff = hSq - rSq;
  return (315.0 / (64.0 * PI * pow(h, 9.0))) * diff * diff * diff;
}

// Spiky gradient, used for pressure. Non-zero as r approaches 0, which is what
// keeps particles apart.
fn spikyGradient(r: f32, h: f32) -> f32 {
  if (r >= h || r <= 0.0) { return 0.0; }
  let diff = h - r;
  return -(45.0 / (PI * pow(h, 6.0))) * diff * diff;
}

fn viscosityLaplacian(r: f32, h: f32) -> f32 {
  if (r >= h) { return 0.0; }
  return (45.0 / (PI * pow(h, 6.0))) * (h - r);
}

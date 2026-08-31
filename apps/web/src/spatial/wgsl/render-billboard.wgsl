// The zero-readback half of the loop: the particle buffer the compute passes
// just wrote is bound here as a *vertex* buffer and drawn directly.
//
// This is the whole point of the invariant. The buffer is created
// `STORAGE | VERTEX`, the compute passes write it, and this pass reads it as
// per-instance vertex attributes — so between the solver and the pixels there
// is no `mapAsync`, no staging buffer, and no point at which the CPU learns
// what the simulation did. That is why the sanity checks in `common.wgsl` are
// on the GPU: there is no other place left to put them.
//
// It also means the attribute layout below and the `Particle` struct in
// `common.wgsl` are the same 32 bytes described twice, in two languages, with
// nothing in either to catch a disagreement. `gpu/bindings.ts` holds the
// offsets once and `shader-contract.test.ts` asserts all three agree; a
// mismatch here does not error, it renders velocity as position.

struct Camera {
  viewProjection: mat4x4<f32>,
  right: vec3<f32>,
  particleRadius: f32,
  up: vec3<f32>,
  restDensity: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexIn {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) position: vec3<f32>,
  @location(1) density: f32,
  @location(2) velocity: vec3<f32>,
  @location(3) pressure: f32,
}

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) speed: f32,
  @location(2) compression: f32,
}

// Six vertices, no index buffer and no vertex buffer for the quad itself. The
// corner offsets are computed from the vertex index because uploading a
// four-vertex quad and an index buffer to describe a shape this fixed costs a
// binding and a buffer to say something the shader can derive for free.
fn cornerOffset(vertexIndex: u32) -> vec2<f32> {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
  );
  return corners[vertexIndex];
}

@vertex
fn vertexMain(input: VertexIn) -> VertexOut {
  let corner = cornerOffset(input.vertexIndex);

  // Camera-facing quad built from the view basis rather than a billboard
  // matrix: two multiply-adds instead of a matrix construction per vertex, and
  // at a quarter of a million instances that difference is the vertex stage.
  let world = input.position
    + camera.right * (corner.x * camera.particleRadius)
    + camera.up * (corner.y * camera.particleRadius);

  var out: VertexOut;
  out.clipPosition = camera.viewProjection * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.speed = length(input.velocity);
  // Relative to rest density, so the shading reads the same whichever solver
  // produced it — MLS-MPM writes restDensity flat (see `mlsmpm-g2p.wgsl`),
  // which lands at exactly zero compression rather than at some arbitrary
  // colour that would make a mid-session demotion look like a physical event.
  out.compression = input.density / max(camera.restDensity, 1.0e-6) - 1.0;
  return out;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> {
  // Round sprite from the quad. Discarding rather than blending the corners
  // keeps the depth buffer honest, which matters because these are drawn
  // unsorted — sorting a quarter million instances per frame on the CPU is
  // exactly the readback this design exists to avoid.
  let radiusSq = dot(input.uv, input.uv);
  if (radiusSq > 1.0) { discard; }

  // A cheap hemisphere normal, so the particles read as spheres under a fixed
  // key light rather than as flat discs. No shadow pass and no lighting
  // uniforms: this is a diagnostic view of a simulation, not a render.
  let normal = vec3<f32>(input.uv, sqrt(max(0.0, 1.0 - radiusSq)));
  let lambert = clamp(dot(normal, normalize(vec3<f32>(0.4, 0.7, 0.6))), 0.0, 1.0);

  // Speed and compression drive hue and brightness. The palette stays out of
  // the magenta the review gate owns (Appendix B.2) — this surface is a
  // simulation readout and must not borrow the colour that means "a person is
  // being asked to decide".
  let cool = vec3<f32>(0.24, 0.45, 0.85);
  let warm = vec3<f32>(0.35, 0.80, 0.90);
  let base = mix(cool, warm, clamp(input.speed * 0.25, 0.0, 1.0));
  let tint = base * (0.55 + 0.45 * lambert)
    + vec3<f32>(0.10, 0.06, 0.0) * clamp(input.compression, 0.0, 1.0);

  return vec4<f32>(tint, 1.0);
}

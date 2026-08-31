/**
 * The one place the GPU resource layout is written down.
 *
 * Every number here is also written in WGSL, in a different language, with no
 * compiler between the two. A struct field that moves in `common.wgsl` and not
 * here does not fail to build — it produces a simulation that reads velocity
 * where it meant to read position, runs at full speed, and looks like a physics
 * bug. `shader-contract.test.ts` parses the shader sources and asserts they
 * agree with this file, which is the only thing in the repo that can catch it.
 *
 * Explicit bind group layouts rather than `layout: 'auto'` for the same reason:
 * auto layout is derived from the bindings an entry point *statically uses*, so
 * the density pass and the integrate pass would each get a different layout
 * from the same declarations, and a bind group built for one would be rejected
 * by the other. Declaring the layout once and using it everywhere makes the
 * unused bindings in a given pass a non-event.
 */

/** Invocations per workgroup, matching `@workgroup_size(256)` in every pass. */
export const WORKGROUP_SIZE = 256;

/** Elements scanned per block in `prefix-sum.wgsl`. */
export const SCAN_BLOCK_SIZE = 256;

/**
 * The prefix sum is two-level: blocks are scanned, then the block totals are
 * scanned by a single workgroup. That second scan is one workgroup wide, so it
 * can cover at most `SCAN_BLOCK_SIZE` blocks and therefore
 * `SCAN_BLOCK_SIZE ** 2` cells. Asserted when the grid is sized rather than
 * handled by a third level, because a grid this large does not fit in the
 * buffers anyway and unreachable code that manipulates offsets is worse than
 * a thrown error at allocation.
 */
export const MAX_GRID_CELLS = SCAN_BLOCK_SIZE * SCAN_BLOCK_SIZE;

/**
 * `Particle`, from `common.wgsl`. Also the per-instance vertex layout in
 * `render-billboard.wgsl` — the same 32 bytes, described a third time, because
 * the buffer is `STORAGE | VERTEX` and is never read back.
 */
export const PARTICLE_STRIDE_BYTES = 32;

export const PARTICLE_FIELD_OFFSETS = {
  position: 0,
  density: 12,
  velocity: 16,
  pressure: 28,
} as const;

/** `SimParams`, from `common.wgsl`. 80 bytes: a multiple of 16, as uniforms must be. */
export const SIM_PARAMS_SIZE_BYTES = 80;

export const SIM_PARAMS_FIELD_OFFSETS = {
  gridMin: 0,
  cellSize: 12,
  gridDim: 16,
  particleCount: 28,
  gravity: 32,
  dt: 44,
  restDensity: 48,
  stiffness: 52,
  viscosity: 56,
  smoothingRadius: 60,
  maxSpeed: 64,
  particleMass: 68,
} as const;

/** `Camera`, from `render-billboard.wgsl`. mat4x4 is 64, then two vec3+f32 rows. */
export const CAMERA_UNIFORM_SIZE_BYTES = 96;

/**
 * Group 0 — the simulation bindings, shared by every compute pass.
 * The index is the `@binding(n)` in `common.wgsl`.
 */
export const SIMULATION_BINDINGS = {
  params: 0,
  particles: 1,
  cellCounts: 2,
  cellOffsets: 3,
  sortedIndices: 4,
  particleCellIds: 5,
} as const;

/** Group 1 during the prefix sum only. See the note in `prefix-sum.wgsl`. */
export const SCAN_BINDINGS = {
  blockSums: 0,
} as const;

/** Group 1 during the MLS-MPM passes only. See `mlsmpm-common.wgsl`. */
export const MPM_BINDINGS = {
  gridMass: 0,
  gridMomentum: 1,
  particleAffine: 2,
} as const;

/** Three i32 per cell — x, y, z — in `gridMomentum`. */
export const MOMENTUM_COMPONENTS = 3;

/** mat3x3<f32> in a storage buffer occupies three 16-byte columns. */
export const AFFINE_STRIDE_BYTES = 48;

/**
 * The SPH frame, in dispatch order.
 *
 * `clearCounts` appears twice and that is not a mistake. `cellCounts` is used
 * for two different things in one frame: the counting sort's histogram, which
 * the prefix sum consumes, and then a per-cell write cursor for `scatter`. The
 * second clear is what separates those two uses. Without it, `scatter` starts
 * every cell's cursor at that cell's own count and writes each particle one
 * full run past where it belongs — which does not crash, because the buffer is
 * large enough, and produces neighbour lists that are silently one cell wrong.
 */
export const SPH_PASSES = [
  'clearCounts',
  'countCells',
  'scanBlocks',
  'scanBlockSums',
  'addBlockOffsets',
  'clearCounts',
  'scatter',
  'density',
  'force',
  'integrate',
] as const;

/**
 * The MLS-MPM frame. No sort: the grid does the coupling, so the hash and all
 * three scan passes are absent. This is the structural reason it is the cheaper
 * solver, and it is visible here as six passes against ten.
 */
export const MPM_PASSES = [
  'clearGrid',
  'p2g',
  'gridUpdate',
  'g2p',
  'integrate',
] as const;

export type SphPass = (typeof SPH_PASSES)[number];
export type MpmPass = (typeof MPM_PASSES)[number];

/** Workgroups needed to cover `count` items at `WORKGROUP_SIZE` each. */
export function workgroupsFor(count: number): number {
  return Math.ceil(count / WORKGROUP_SIZE);
}

/**
 * Grid dimensions for a domain, given the smoothing radius.
 *
 * `cellSize === smoothingRadius` is load-bearing rather than convenient: the
 * SPH passes search a fixed 3×3×3 stencil, which only finds every neighbour
 * within `h` if no such neighbour can be more than one cell away. A larger cell
 * would still be correct and slower; a smaller one silently drops neighbours,
 * and the fluid reads as too compressible rather than as broken. Enforced here
 * because this is the only function that produces a cell size.
 */
export function gridDimensionsFor(
  domain: readonly [number, number, number],
  smoothingRadius: number
): { dim: [number, number, number]; cellSize: number; cellCount: number } {
  if (!(smoothingRadius > 0)) {
    throw new Error(`smoothingRadius must be positive, got ${smoothingRadius}`);
  }
  const cellSize = smoothingRadius;
  const dim = domain.map((extent) =>
    Math.max(1, Math.ceil(extent / cellSize))
  ) as [number, number, number];
  const cellCount = dim[0] * dim[1] * dim[2];

  if (cellCount > MAX_GRID_CELLS) {
    throw new Error(
      `grid of ${cellCount} cells exceeds the two-level prefix sum's ceiling of ${MAX_GRID_CELLS}; ` +
        `increase the smoothing radius or shrink the domain`
    );
  }
  return { dim, cellSize, cellCount };
}

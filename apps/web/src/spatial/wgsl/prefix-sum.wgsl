// Exclusive prefix sum over the per-cell counts, turning "how many particles
// are in cell i" into "where cell i's run starts in sortedIndices".
//
// Three dispatches, the standard decomposition: scan each block in workgroup
// memory and emit that block's total; scan the block totals; add each block's
// offset back. Two levels are enough for the grids this engine builds — at 256
// cells per block, two levels cover 65,536 blocks, which is 16.7 million cells,
// well past the point where the grid itself stops fitting in memory. A third
// level would be dead code, so `bindings.ts` asserts the cell count instead of
// this shader growing one.
//
// Hillis-Steele rather than Blelloch: it does more work in total (n log n
// versus n) but half the barriers and no down-sweep, and at 256 elements per
// block on a GPU the barrier count is what costs. Blelloch wins at sizes this
// never reaches.

const SCAN_BLOCK: u32 = 256u;

// Scan-local. Declared here rather than in `common.wgsl` because nothing else
// in the engine has block sums, and a binding that exists for one pass but is
// declared for all of them is a binding someone will eventually reuse for
// something unrelated.
@group(1) @binding(0) var<storage, read_write> blockSums: array<u32>;

var<workgroup> scratch: array<u32, SCAN_BLOCK>;

@compute @workgroup_size(256)
fn scanBlocks(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let total = cellCount();
  let i = gid.x;
  let t = lid.x;

  scratch[t] = select(0u, atomicLoad(&cellCounts[i]), i < total);
  workgroupBarrier();

  // Inclusive scan in place. `offset` doubles, and each step reads a value the
  // previous step wrote, so both barriers are required — the second one is the
  // easy one to drop and the resulting race is data-dependent and rare.
  for (var offset: u32 = 1u; offset < SCAN_BLOCK; offset = offset << 1u) {
    var addend: u32 = 0u;
    if (t >= offset) { addend = scratch[t - offset]; }
    workgroupBarrier();
    scratch[t] = scratch[t] + addend;
    workgroupBarrier();
  }

  // Converted to exclusive on write: cell i's run starts after every earlier
  // cell's, and an inclusive scan would have it start one run too late.
  if (i < total) {
    cellOffsets[i] = scratch[t] - atomicLoad(&cellCounts[i]);
  }
  if (t == SCAN_BLOCK - 1u) {
    blockSums[wid.x] = scratch[t];
  }
}

// One workgroup, scanning the block totals. Bounded by the two-level argument
// above: `blockCount` cannot exceed SCAN_BLOCK without the grid exceeding what
// the engine will allocate.
@compute @workgroup_size(256)
fn scanBlockSums(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;
  let blockCount = (cellCount() + SCAN_BLOCK - 1u) / SCAN_BLOCK;

  scratch[t] = select(0u, blockSums[t], t < blockCount);
  workgroupBarrier();

  for (var offset: u32 = 1u; offset < SCAN_BLOCK; offset = offset << 1u) {
    var addend: u32 = 0u;
    if (t >= offset) { addend = scratch[t - offset]; }
    workgroupBarrier();
    scratch[t] = scratch[t] + addend;
    workgroupBarrier();
  }

  // Read before write: `scratch[t]` is the inclusive total and `blockSums[t]`
  // is still this block's own contribution, so subtracting makes it exclusive.
  if (t < blockCount) {
    blockSums[t] = scratch[t] - blockSums[t];
  }
}

@compute @workgroup_size(256)
fn addBlockOffsets(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let i = gid.x;
  if (i >= cellCount()) { return; }
  cellOffsets[i] = cellOffsets[i] + blockSums[wid.x];
}

// Spatial hash construction: counting sort by grid cell.
//
// Three passes, two of them here and the prefix sum between them in
// `prefix-sum.wgsl`:
//
//   1. `countCells`   — one atomicAdd per particle into its cell's counter
//   2. (prefix sum)   — counts become the start offset of each cell's run
//   3. `scatter`      — one atomicAdd per particle to claim a slot in that run
//
// A counting sort rather than a radix sort because the key is already the cell
// index and the number of cells is known: there is nothing to sort *by* that a
// bucket does not answer directly. It is also stable in the only sense that
// matters here, which is that it terminates in a fixed three dispatches
// regardless of the distribution — a radix sort's pass count depends on the key
// width and its cost depends on how clustered the fluid is, and a fluid is
// always clustered.
//
// `sortedIndices` is deliberately an index buffer rather than a reordered copy
// of the particles. Reordering would double the particle traffic every frame
// and, worse, would move a particle's identity between frames — which is
// exactly what the CRDT in Phase 3 is going to need to stay put.

@compute @workgroup_size(256)
fn countCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount) { return; }

  let cell = cellIndex(cellCoord(particles[i].position));
  particleCellIds[i] = cell;
  atomicAdd(&cellCounts[cell], 1u);
}

@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount) { return; }

  let cell = particleCellIds[i];
  // cellCounts has been zeroed and is reused here as a per-cell write cursor.
  // Reusing it rather than allocating a third buffer is worth the confusion
  // this comment is paying for: at a quarter of a million particles the extra
  // buffer is real memory, and the counts themselves are dead once the prefix
  // sum has consumed them.
  let slot = atomicAdd(&cellCounts[cell], 1u);
  sortedIndices[cellOffsets[cell] + slot] = i;
}

// Zeroing is a dispatch rather than a `queue.writeBuffer` of a zero-filled
// staging array: the cell count runs to hundreds of thousands, and uploading
// that much zero every frame is bandwidth spent to communicate nothing.
@compute @workgroup_size(256)
fn clearCounts(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= cellCount()) { return; }
  atomicStore(&cellCounts[i], 0u);
}

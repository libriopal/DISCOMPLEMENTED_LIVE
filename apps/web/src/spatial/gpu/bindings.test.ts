import { describe, expect, it } from 'vitest';

import {
  MAX_GRID_CELLS,
  MPM_PASSES,
  SCAN_BLOCK_SIZE,
  SPH_PASSES,
  WORKGROUP_SIZE,
  gridDimensionsFor,
  workgroupsFor,
} from './bindings.js';

describe('workgroupsFor', () => {
  it('covers a partial final workgroup', () => {
    expect(workgroupsFor(WORKGROUP_SIZE + 1)).toBe(2);
  });

  it('does not add an empty one at an exact multiple', () => {
    expect(workgroupsFor(WORKGROUP_SIZE * 4)).toBe(4);
  });

  it('dispatches nothing for nothing', () => {
    expect(workgroupsFor(0)).toBe(0);
  });
});

describe('gridDimensionsFor', () => {
  it('makes the cell size equal to the smoothing radius', () => {
    // Load-bearing rather than convenient: the SPH passes search a fixed 3×3×3
    // stencil, which finds every neighbour within h only if no neighbour can be
    // more than one cell away. A smaller cell silently drops neighbours and the
    // fluid reads as too compressible rather than as broken.
    expect(gridDimensionsFor([4, 4, 4], 0.5).cellSize).toBe(0.5);
  });

  it('covers the domain, rounding up', () => {
    const { dim } = gridDimensionsFor([1.1, 2, 3], 1);
    expect(dim).toEqual([2, 2, 3]);
  });

  it('reports a cell count consistent with its dimensions', () => {
    const { dim, cellCount } = gridDimensionsFor([8, 4, 2], 0.5);
    expect(cellCount).toBe(dim[0] * dim[1] * dim[2]);
  });

  it('never produces a zero-width axis', () => {
    // A flat domain would otherwise index a grid with a zero stride, which
    // collapses every cell onto one and turns the hash into a linear scan.
    expect(gridDimensionsFor([0, 0, 0], 1).dim).toEqual([1, 1, 1]);
  });

  it('refuses a non-positive smoothing radius', () => {
    for (const bad of [0, -1, NaN]) {
      expect(() => gridDimensionsFor([1, 1, 1], bad)).toThrow(
        /smoothingRadius/
      );
    }
  });

  it('refuses a grid the two-level prefix sum cannot scan', () => {
    // The second scan is one workgroup wide, so it covers at most
    // SCAN_BLOCK_SIZE blocks. Above that the scan silently drops the tail of
    // the grid, and every particle in it gets an empty neighbour list.
    expect(() => gridDimensionsFor([1000, 1000, 1000], 1)).toThrow(
      /prefix sum/
    );
  });

  it('allows a grid exactly at the ceiling', () => {
    expect(() =>
      gridDimensionsFor([SCAN_BLOCK_SIZE, SCAN_BLOCK_SIZE, 1], 1)
    ).not.toThrow();
    expect(MAX_GRID_CELLS).toBe(SCAN_BLOCK_SIZE * SCAN_BLOCK_SIZE);
  });
});

describe('SPH_PASSES', () => {
  it('clears the cell counts twice', () => {
    // `cellCounts` is two things in one frame: the counting sort's histogram,
    // which the prefix sum consumes, and then a per-cell write cursor for
    // `scatter`. Without the second clear every cell's cursor starts at its own
    // count and every particle lands one full run past its slot — which does
    // not crash, because the buffer is large enough, and produces neighbour
    // lists that are silently one cell wrong.
    expect(SPH_PASSES.filter((pass) => pass === 'clearCounts')).toHaveLength(2);
  });

  it('clears immediately before each consumer of the buffer', () => {
    const passes = [...SPH_PASSES];
    expect(passes[passes.indexOf('countCells') - 1]).toBe('clearCounts');
    expect(passes[passes.indexOf('scatter') - 1]).toBe('clearCounts');
  });

  it('scans between counting and scattering', () => {
    const at = (pass: string) => SPH_PASSES.indexOf(pass as never);
    expect(at('countCells')).toBeLessThan(at('scanBlocks'));
    expect(at('addBlockOffsets')).toBeLessThan(at('scatter'));
  });

  it('computes density before the forces that read it', () => {
    // Split into two passes because a force needs its neighbours' *finished*
    // densities; fused, half the neighbours would contribute last frame's.
    const at = (pass: string) => SPH_PASSES.indexOf(pass as never);
    expect(at('density')).toBeLessThan(at('force'));
    expect(at('force')).toBeLessThan(at('integrate'));
  });

  it('integrates last', () => {
    expect(SPH_PASSES[SPH_PASSES.length - 1]).toBe('integrate');
  });
});

describe('MPM_PASSES', () => {
  it('runs the transfer in order', () => {
    expect([...MPM_PASSES]).toEqual([
      'clearGrid',
      'p2g',
      'gridUpdate',
      'g2p',
      'integrate',
    ]);
  });

  it('clears the grid before scattering into it', () => {
    // The grid buffers are accumulated into with atomics, so a frame that skips
    // the clear adds this frame's momentum to last frame's and the fluid
    // accelerates without a force.
    expect(MPM_PASSES.indexOf('clearGrid')).toBeLessThan(
      MPM_PASSES.indexOf('p2g')
    );
  });

  it('shares the integrate pass with SPH', () => {
    // One place writes a particle position and one boundary behaviour serves
    // both solvers, so a mid-session demotion cannot change how the fluid meets
    // the walls.
    expect(MPM_PASSES).toContain('integrate');
    expect(SPH_PASSES).toContain('integrate');
  });

  it('needs no sort, which is why it is the cheaper solver', () => {
    for (const sortPass of ['countCells', 'scatter', 'scanBlocks']) {
      expect(MPM_PASSES).not.toContain(sortPass);
    }
    expect(MPM_PASSES.length).toBeLessThan(SPH_PASSES.length);
  });
});

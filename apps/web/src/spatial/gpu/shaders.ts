/**
 * Shader module composition.
 *
 * WGSL has no include directive, so the preludes are concatenated here. Two of
 * them, in a fixed order: `common.wgsl` for everything that touches the
 * simulation, plus `mlsmpm-common.wgsl` for the three MPM passes.
 *
 * `render-billboard.wgsl` deliberately gets neither. It declares its own
 * `Camera` uniform at group 0 binding 0, which is the same slot `SimParams`
 * occupies in the compute passes — a render pipeline and a compute pipeline
 * have separate layouts, so that is legal, and composing the compute prelude
 * into it would collide on the binding rather than share it.
 *
 * Composition happens at module scope so that a WGSL syntax error surfaces at
 * pipeline creation on the first frame, not on the frame a solver is demoted.
 * A shader that fails to compile the first time a founder's fluid slows down
 * is the worst possible time to find out.
 */

import common from '../wgsl/common.wgsl?raw';
import mpmCommon from '../wgsl/mlsmpm-common.wgsl?raw';
import spatialHash from '../wgsl/spatial-hash.wgsl?raw';
import prefixSum from '../wgsl/prefix-sum.wgsl?raw';
import sphDensity from '../wgsl/sph-density.wgsl?raw';
import sphForce from '../wgsl/sph-force.wgsl?raw';
import integrate from '../wgsl/integrate.wgsl?raw';
import mpmP2g from '../wgsl/mlsmpm-p2g.wgsl?raw';
import mpmGrid from '../wgsl/mlsmpm-grid.wgsl?raw';
import mpmG2p from '../wgsl/mlsmpm-g2p.wgsl?raw';
import renderBillboard from '../wgsl/render-billboard.wgsl?raw';

function compose(...parts: string[]): string {
  return parts.join('\n\n');
}

export const SHADER_SOURCES = {
  spatialHash: compose(common, spatialHash),
  prefixSum: compose(common, prefixSum),
  sphDensity: compose(common, sphDensity),
  sphForce: compose(common, sphForce),
  integrate: compose(common, integrate),
  mpmP2g: compose(common, mpmCommon, mpmP2g),
  mpmGrid: compose(common, mpmCommon, mpmGrid),
  mpmG2p: compose(common, mpmCommon, mpmG2p),
  renderBillboard,
} as const;

export type ShaderName = keyof typeof SHADER_SOURCES;

/**
 * Entry point names per module, as the pipelines request them.
 *
 * Written out rather than inferred: `createComputePipeline` fails at pipeline
 * creation with a name that does not exist in the module, and having the set
 * in one object is what lets `shader-contract.test.ts` check every one of them
 * against the `@compute` declarations in the sources.
 */
export const SHADER_ENTRY_POINTS: Record<ShaderName, readonly string[]> = {
  spatialHash: ['clearCounts', 'countCells', 'scatter'],
  prefixSum: ['scanBlocks', 'scanBlockSums', 'addBlockOffsets'],
  sphDensity: ['main'],
  sphForce: ['main'],
  integrate: ['main'],
  mpmP2g: ['clearGrid', 'main'],
  mpmGrid: ['main'],
  mpmG2p: ['main'],
  renderBillboard: ['vertexMain', 'fragmentMain'],
};

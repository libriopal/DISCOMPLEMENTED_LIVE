/**
 * Which rendering path the studio takes, and what the founder is told about it.
 *
 * WebGPU became Baseline in January 2026 and is still absent for roughly three
 * in ten mobile browsers, so the fallback is a supported path rather than an
 * error case. That distinction is the whole point of this module: a machine
 * without WebGPU has not failed, and the studio must not present it as though
 * it has.
 *
 * The sentences live here rather than in the components for the same reason
 * pipeline copy lives in `lib/pipeline-legibility.ts` — they are the part worth
 * pinning by test, and they are wrong more often than layout is. They state
 * what is running and why, and they carry no figure: there is no measured
 * comparison between these paths in this repo, so "reduced detail" is as
 * specific as this code has earned the right to be (ground rule 2).
 */

import type { SpatialCapabilities } from '../capabilities.js';
import { canUseSharedMemoryBus } from '../capabilities.js';

export type RenderPath = 'webgpu' | 'webgl2' | 'static';

export interface RenderPathChoice {
  path: RenderPath;
  /** Shown in the studio when the path is not `webgpu`. Never a percentage. */
  notice: string | null;
}

export function chooseRenderPath(caps: SpatialCapabilities): RenderPathChoice {
  if (caps.webgpu) {
    return { path: 'webgpu', notice: null };
  }
  if (caps.webgl2) {
    return {
      path: 'webgl2',
      notice:
        'This browser does not support WebGPU, so the simulation is running on the older graphics path at reduced detail. Everything you build here still works and still saves.',
    };
  }
  return {
    path: 'static',
    notice:
      'This browser cannot run the simulation, so the canvas is showing your blueprint without it. You can still add, connect and edit blocks, and they will simulate on a device that supports it.',
  };
}

/**
 * Whether the shared-memory bus is available *and* worth using on this path.
 *
 * The static path has no per-frame state to share, so isolating the document
 * buys it nothing; asking for a `SharedArrayBuffer` there would allocate a ring
 * buffer that never fills. Both other paths use it when the capabilities allow.
 *
 * "When the capabilities allow" is `canUseSharedMemoryBus` and not a second
 * opinion about it. This function briefly held its own `crossOriginIsolated &&
 * sharedArrayBuffer` test, which is the same question answered differently:
 * it omitted `Atomics.waitAsync`, so a browser with a `SharedArrayBuffer` and
 * no async wait would have been handed a ring buffer the window has no
 * non-blocking way to wait on — `Atomics.wait` throws on the main thread. The
 * path is the only thing this function is allowed to add.
 */
export function shouldUseSharedMemory(
  caps: SpatialCapabilities,
  path: RenderPath
): boolean {
  if (path === 'static') return false;
  return canUseSharedMemoryBus(caps);
}

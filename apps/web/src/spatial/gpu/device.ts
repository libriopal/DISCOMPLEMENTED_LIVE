/**
 * Getting a GPU device, deciding what to run on it, and surviving losing it.
 *
 * ## The types here are a local subset, not the WebGPU spec
 *
 * `@webgpu/types` is the right dependency for this and cannot currently be
 * installed: pnpm refuses to resolve any new dependency in this workspace
 * while `husky@9.1.0` fails its trust check ("High-risk trust downgrade …
 * earlier versions had provenance attestation"). Bypassing a supply-chain
 * check to add a convenience type package is not a trade worth making, so the
 * handful of members this module touches are described structurally below.
 * They are named `…Like` so nobody mistakes them for the real interfaces, and
 * they should be deleted the moment that install works.
 *
 * ## Device loss is reported, not silently repaired
 *
 * A lost device is not an error the founder caused and not one the page can
 * hide. `GPUDevice` is destroyed along with every buffer on it, so the particle
 * state — which by design lives only on the GPU, see `render-billboard.wgsl` —
 * is gone with it. Re-acquiring gives a working canvas again; it does not give
 * back the simulation that was running, and this module says so rather than
 * restarting from seed state and letting it look like a glitch.
 *
 * Keeping a CPU-side mirror so the state could be restored is real work — it
 * needs a WASM linear-memory shadow buffer that does not exist here, and
 * `esbuild-wasm` is an isolated module with no memory to borrow. That is gap
 * G7 in the plan and it is deliberately not pretended at here.
 */

import type {
  AdapterInfoLike,
  AdapterLimitsLike,
  GpuTier,
  Solver,
} from './profile.js';
import {
  classifyAdapter,
  defaultSolverFor,
  initialParticleCount,
} from './profile.js';

export interface DeviceLostInfo {
  reason: string;
  message: string;
}

export interface DeviceLike {
  readonly limits: AdapterLimitsLike;
  readonly lost: Promise<DeviceLostInfo>;
  destroy(): void;
}

export interface AdapterLike {
  readonly info?: Partial<AdapterInfoLike>;
  readonly limits: AdapterLimitsLike;
  readonly isFallbackAdapter?: boolean;
  requestDevice(descriptor?: {
    label?: string;
    requiredLimits?: Record<string, number>;
  }): Promise<DeviceLike>;
}

export interface GpuLike {
  requestAdapter(options?: {
    powerPreference?: 'high-performance' | 'low-power';
  }): Promise<AdapterLike | null>;
}

export interface AcquiredDevice {
  device: DeviceLike;
  tier: GpuTier;
  solver: Solver;
  particleCount: number;
  info: AdapterInfoLike;
}

export type AcquireFailure =
  | { kind: 'no-webgpu' }
  | { kind: 'no-adapter' }
  | { kind: 'device-rejected'; message: string };

export type AcquireResult =
  | ({ ok: true } & AcquiredDevice)
  | ({ ok: false } & AcquireFailure);

/**
 * `adapter.info` is optional, and every field of it may be an empty string —
 * WebGPU restricts what it will say about the hardware to limit
 * fingerprinting. Normalised here so `classifyAdapter` never has to branch on
 * undefined, and so that "the browser told us nothing" and "the browser told us
 * it is an Adreno" are the same shape of input.
 */
function normalizeInfo(
  info: Partial<AdapterInfoLike> | undefined
): AdapterInfoLike {
  return {
    vendor: info?.vendor ?? '',
    architecture: info?.architecture ?? '',
    device: info?.device ?? '',
    description: info?.description ?? '',
  };
}

export async function acquireDevice(
  gpu: GpuLike | undefined
): Promise<AcquireResult> {
  if (!gpu) return { ok: false, kind: 'no-webgpu' };

  // `high-performance` asks for the discrete GPU on a dual-GPU laptop. It is a
  // hint the browser may ignore, which is precisely why the tier is classified
  // from what comes back rather than from what was asked for.
  const adapter = await gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) return { ok: false, kind: 'no-adapter' };

  const info = normalizeInfo(adapter.info);
  const tier = classifyAdapter(
    info,
    adapter.limits,
    adapter.isFallbackAdapter === true
  );

  let device: DeviceLike;
  try {
    device = await adapter.requestDevice({
      label: 'spatial-engine',
      // Requesting the adapter's own limits rather than raising them: asking
      // for more than an adapter supports rejects the whole device, and there
      // is nothing this engine needs that the WebGPU floor does not provide.
      // Asking for exactly what is there keeps the request from being the
      // thing that fails on unusual hardware.
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
  } catch (err) {
    return {
      ok: false,
      kind: 'device-rejected',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    device,
    tier,
    solver: defaultSolverFor(tier),
    particleCount: initialParticleCount(tier),
    info,
  };
}

/**
 * Run `onLost` if and when the device is lost.
 *
 * `device.lost` resolves rather than rejects, including when the device was
 * destroyed deliberately — so `reason === 'destroyed'` is a normal teardown and
 * is filtered out here. Passing it through would fire the recovery path on
 * every page navigation, which is how a "GPU lost" notice ends up appearing as
 * someone closes the studio.
 */
export function onDeviceLost(
  device: DeviceLike,
  handler: (info: DeviceLostInfo) => void
): void {
  void device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    handler(info);
  });
}

/**
 * What the founder is told when the device is lost. No figure and no blame:
 * the causes are a driver reset, a GPU hot-unplug, or the OS reclaiming the
 * device under memory pressure, and the page cannot distinguish them.
 */
export const DEVICE_LOST_NOTICE =
  'The graphics device was reset, so the simulation stopped and its current state was lost. Your blocks and connections are saved. Reload to start it again.';

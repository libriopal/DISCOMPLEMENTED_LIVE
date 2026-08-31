/**
 * Picking a starting solver from what the adapter says about itself.
 *
 * ## This is a guess, and the design depends on it being allowed to be wrong
 *
 * WebGPU deliberately blurs the hardware it runs on: `adapter.info` may return
 * empty strings, browsers normalise the architecture names they do return, and
 * nothing exposes "is this a discrete GPU". So no classification here can be
 * relied on, and none of this module's callers do. The tier chooses which
 * solver to *start* with; `dispatch.ts` measures the frame that results and
 * `solver-switch.ts` demotes on the evidence. A wrong guess costs a few frames,
 * not a crash — which is the only reason guessing is acceptable at all.
 *
 * Read in that order, the priority is: refuse to over-promise. A machine we
 * cannot classify is treated as integrated rather than discrete, because
 * starting an SPH solve on a laptop iGPU and demoting is a stutter, while
 * starting MLS-MPM on a 4090 and promoting is a few frames of headroom nobody
 * notices.
 */

/** The `GPUAdapterInfo` fields this module reads. All may be empty strings. */
export interface AdapterInfoLike {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

/** The `GPUSupportedLimits` fields this module reads. */
export interface AdapterLimitsLike {
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxComputeInvocationsPerWorkgroup: number;
  maxComputeWorkgroupStorageSize: number;
}

export type GpuTier = 'discrete' | 'integrated' | 'mobile';

/**
 * `sph` is Smoothed Particle Hydrodynamics — a neighbour search per particle,
 * accurate and expensive. `mls-mpm` is Moving Least Squares Material Point
 * Method, which scatters to a grid instead and so skips the sort entirely; it
 * is cheaper and less accurate, which is the trade the mobile tier wants.
 */
export type Solver = 'sph' | 'mls-mpm';

/**
 * Architecture substrings that identify a mobile or embedded GPU.
 *
 * Matched against the lowercased `architecture` and `vendor`, which is where
 * Chromium puts a normalised family name ("adreno-6xx", "apple-g13"). Absent
 * or unrecognised falls through to the limits check below — this list is an
 * accelerator for the common case, never the only path.
 */
const MOBILE_ARCHITECTURES = [
  'adreno',
  'mali',
  'powervr',
  'apple-g', // apple-g13, apple-g14 … the A-series and M-series share the prefix
  'xclipse',
  'immortalis',
] as const;

/**
 * Limits at which we are willing to call an adapter discrete.
 *
 * These are *above* the WebGPU guaranteed minimums (128 MiB storage binding,
 * 256 MiB buffer, 256 invocations, 16 KiB workgroup storage), because the
 * guaranteed minimums are exactly what a conservative integrated driver
 * reports. An adapter that only meets the spec floor tells us nothing, and
 * "tells us nothing" resolves to integrated.
 */
const DISCRETE_THRESHOLDS = {
  maxStorageBufferBindingSize: 1024 * 1024 * 1024,
  maxBufferSize: 1024 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupStorageSize: 32768,
} as const;

export function classifyAdapter(
  info: AdapterInfoLike,
  limits: AdapterLimitsLike,
  isFallbackAdapter: boolean
): GpuTier {
  // A fallback adapter is a software rasteriser by definition. It will run
  // anything and finish nothing in time, so it gets the cheapest solver.
  if (isFallbackAdapter) return 'mobile';

  const haystack = `${info.architecture} ${info.vendor}`.toLowerCase();
  if (MOBILE_ARCHITECTURES.some((family) => haystack.includes(family))) {
    return 'mobile';
  }

  const meetsAll =
    limits.maxStorageBufferBindingSize >=
      DISCRETE_THRESHOLDS.maxStorageBufferBindingSize &&
    limits.maxBufferSize >= DISCRETE_THRESHOLDS.maxBufferSize &&
    limits.maxComputeInvocationsPerWorkgroup >=
      DISCRETE_THRESHOLDS.maxComputeInvocationsPerWorkgroup &&
    limits.maxComputeWorkgroupStorageSize >=
      DISCRETE_THRESHOLDS.maxComputeWorkgroupStorageSize;

  return meetsAll ? 'discrete' : 'integrated';
}

/**
 * The solver a tier starts on.
 *
 * Only `discrete` gets SPH. The blueprint's wording is "default SPH for
 * discrete GPUs, degrade to MLS-MPM for integrated GPUs or mobile", and that
 * is this function in full.
 */
export function defaultSolverFor(tier: GpuTier): Solver {
  return tier === 'discrete' ? 'sph' : 'mls-mpm';
}

/**
 * How many particles to start with.
 *
 * Also a starting point rather than a cap — the budget governor scales the
 * active count down from here when frames run long. The numbers are chosen so
 * that the *initial* dispatch cannot be the thing that trips a driver reset on
 * the weakest tier, not from a benchmark; there is no measured figure behind
 * them yet and this comment is the honest version of that.
 */
export function initialParticleCount(tier: GpuTier): number {
  switch (tier) {
    case 'discrete':
      return 262144;
    case 'integrated':
      return 65536;
    case 'mobile':
      return 16384;
  }
}

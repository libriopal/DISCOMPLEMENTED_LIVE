import { describe, expect, it } from 'vitest';

import {
  classifyAdapter,
  defaultSolverFor,
  initialParticleCount,
  type AdapterInfoLike,
  type AdapterLimitsLike,
  type GpuTier,
} from './profile.js';

/** What a conservative driver reports: exactly the WebGPU guaranteed minimums. */
const SPEC_FLOOR: AdapterLimitsLike = {
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupStorageSize: 16384,
};

const GENEROUS: AdapterLimitsLike = {
  maxStorageBufferBindingSize: 2 * 1024 * 1024 * 1024,
  maxBufferSize: 2 * 1024 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupStorageSize: 32768,
};

const info = (overrides: Partial<AdapterInfoLike> = {}): AdapterInfoLike => ({
  vendor: '',
  architecture: '',
  device: '',
  description: '',
  ...overrides,
});

describe('classifyAdapter', () => {
  it('calls a software fallback adapter mobile whatever its limits say', () => {
    // A fallback adapter is a software rasteriser. It reports whatever limits it
    // likes because nothing constrains it, and it will finish nothing in time.
    expect(classifyAdapter(info(), GENEROUS, true)).toBe('mobile');
  });

  it('recognises the mobile architectures by name', () => {
    for (const architecture of [
      'adreno-7xx',
      'mali-g78',
      'powervr-bxm',
      'apple-g13x',
      'xclipse-920',
      'immortalis-g720',
    ]) {
      expect(classifyAdapter(info({ architecture }), GENEROUS, false)).toBe(
        'mobile'
      );
    }
  });

  it('matches the architecture case-insensitively', () => {
    expect(
      classifyAdapter(info({ architecture: 'Adreno-750' }), GENEROUS, false)
    ).toBe('mobile');
  });

  it('reads the vendor as well as the architecture', () => {
    // Some browsers report the family in one field and some in the other, and
    // an empty `architecture` is a permitted answer.
    expect(
      classifyAdapter(info({ vendor: 'qualcomm adreno' }), GENEROUS, false)
    ).toBe('mobile');
  });

  it('calls an adapter with generous limits and no mobile marker discrete', () => {
    expect(
      classifyAdapter(info({ architecture: 'ampere' }), GENEROUS, false)
    ).toBe('discrete');
  });

  it('resolves an adapter reporting only the spec floor to integrated', () => {
    // The spec floor is what an adapter reports when it is telling us nothing,
    // and "nothing" must never resolve upward. Guessing discrete here is the
    // one guess that hurts: it starts a quarter-million particles on hardware
    // that cannot hold them, and the first thing the founder sees is the
    // governor cutting.
    expect(classifyAdapter(info(), SPEC_FLOOR, false)).toBe('integrated');
  });

  it('needs every threshold, not a majority of them', () => {
    for (const key of Object.keys(GENEROUS) as Array<keyof AdapterLimitsLike>) {
      const limits = { ...GENEROUS, [key]: SPEC_FLOOR[key] };
      expect(classifyAdapter(info(), limits, false)).toBe('integrated');
    }
  });

  it('never returns discrete for an adapter that said nothing at all', () => {
    // Every field empty and every limit zero is what a privacy-hardened browser
    // produces, and it is the input most likely to reach production.
    const nothing: AdapterLimitsLike = {
      maxStorageBufferBindingSize: 0,
      maxBufferSize: 0,
      maxComputeInvocationsPerWorkgroup: 0,
      maxComputeWorkgroupStorageSize: 0,
    };
    expect(classifyAdapter(info(), nothing, false)).toBe('integrated');
  });
});

describe('defaultSolverFor', () => {
  it('gives SPH to discrete only', () => {
    expect(defaultSolverFor('discrete')).toBe('sph');
    expect(defaultSolverFor('integrated')).toBe('mls-mpm');
    expect(defaultSolverFor('mobile')).toBe('mls-mpm');
  });
});

describe('initialParticleCount', () => {
  const tiers: GpuTier[] = ['discrete', 'integrated', 'mobile'];

  it('descends with the tier', () => {
    const counts = tiers.map(initialParticleCount);
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[2]);
  });

  it('is a whole number of workgroups on every tier', () => {
    // A count that is not a multiple of the workgroup size leaves a partial
    // final workgroup whose extra invocations return early — correct, but it
    // means the dispatched count and the simulated count differ, and every
    // buffer here is sized from the dispatched one.
    for (const tier of tiers) {
      expect(initialParticleCount(tier) % 256).toBe(0);
    }
  });

  it('is positive on every tier', () => {
    for (const tier of tiers) {
      expect(initialParticleCount(tier)).toBeGreaterThan(0);
    }
  });
});

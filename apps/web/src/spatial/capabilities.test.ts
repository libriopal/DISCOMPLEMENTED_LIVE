import { describe, expect, it } from 'vitest';

import {
  canUseSharedMemoryBus,
  probeCapabilities,
  readCapabilityEnv,
  type CapabilityEnv,
} from './capabilities.js';

const FULL: CapabilityEnv = {
  crossOriginIsolated: true,
  hasSharedArrayBuffer: true,
  hasAtomicsWaitAsync: true,
  hasWebGPU: true,
  hasWebGL2: true,
};

const env = (overrides: Partial<CapabilityEnv> = {}): CapabilityEnv => ({
  ...FULL,
  ...overrides,
});

const gapNames = (e: CapabilityEnv) =>
  probeCapabilities(e).gaps.map((g) => g.capability);

describe('probeCapabilities', () => {
  it('reports no gaps when everything is present', () => {
    expect(probeCapabilities(FULL).gaps).toEqual([]);
  });

  it('never throws, whatever is missing', () => {
    // Every gap here is survivable — a browser without SharedArrayBuffer runs
    // the solver over postMessage, one without WebGPU renders the fallback. A
    // throw would turn a degraded studio into no studio at all.
    const nothing: CapabilityEnv = {
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
      hasAtomicsWaitAsync: false,
      hasWebGPU: false,
      hasWebGL2: false,
    };
    expect(() => probeCapabilities(nothing)).not.toThrow();
    expect(probeCapabilities(nothing).gaps.length).toBeGreaterThan(0);
  });

  it('blames the headers when the document is not isolated', () => {
    const [gap] = probeCapabilities(env({ crossOriginIsolated: false })).gaps;
    expect(gap.capability).toBe('crossOriginIsolated');
    expect(gap.remedy).toContain('isolation.ts');
  });

  it('blames the browser when isolated and SharedArrayBuffer is still absent', () => {
    // The two failures have different remedies — ours and the browser's — and
    // reporting them as one sends every such bug report to read our CSP.
    const [gap] = probeCapabilities(env({ hasSharedArrayBuffer: false })).gaps;
    expect(gap.capability).toBe('SharedArrayBuffer');
    expect(gap.remedy).not.toContain('isolation.ts');
  });

  it('does not report SharedArrayBuffer separately when nothing is isolated', () => {
    // Without isolation the constructor is absent *because* of the headers, so
    // naming it a second time would be one cause reported as two gaps.
    expect(
      gapNames(env({ crossOriginIsolated: false, hasSharedArrayBuffer: false }))
    ).toEqual(['crossOriginIsolated']);
  });

  it('names Atomics.waitAsync independently of the buffer', () => {
    expect(gapNames(env({ hasAtomicsWaitAsync: false }))).toEqual([
      'Atomics.waitAsync',
    ]);
  });

  it('states a different consequence for WebGPU depending on WebGL2', () => {
    const withFallback = probeCapabilities(env({ hasWebGPU: false })).gaps[0];
    const without = probeCapabilities(
      env({ hasWebGPU: false, hasWebGL2: false })
    ).gaps[0];
    expect(withFallback.consequence).not.toBe(without.consequence);
    expect(without.consequence).toContain('static blueprint');
  });

  it('describes what happens instead, never that something breaks', () => {
    const nothing: CapabilityEnv = {
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
      hasAtomicsWaitAsync: false,
      hasWebGPU: false,
      hasWebGL2: false,
    };
    for (const gap of probeCapabilities(nothing).gaps) {
      expect(gap.consequence.length).toBeGreaterThan(0);
      expect(gap.remedy.length).toBeGreaterThan(0);
      expect(gap.consequence).not.toMatch(/\bfail|error|broken\b/i);
    }
  });

  it('carries no percentage in any gap text', () => {
    // Ground rule 2: no quality or capability figure without a derivation in
    // this repo, and these strings reach a founder.
    const nothing: CapabilityEnv = {
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
      hasAtomicsWaitAsync: false,
      hasWebGPU: false,
      hasWebGL2: false,
    };
    for (const gap of probeCapabilities(nothing).gaps) {
      expect(`${gap.consequence} ${gap.remedy}`).not.toMatch(/\d\s*%|percent/i);
    }
  });

  it('passes the environment through unchanged', () => {
    const caps = probeCapabilities(env({ hasWebGPU: false }));
    expect(caps).toMatchObject({
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      atomicsWaitAsync: true,
      webgpu: false,
      webgl2: true,
    });
  });
});

describe('canUseSharedMemoryBus', () => {
  it('needs all three, not two of them', () => {
    expect(canUseSharedMemoryBus(probeCapabilities(FULL))).toBe(true);
    for (const missing of [
      'crossOriginIsolated',
      'hasSharedArrayBuffer',
      'hasAtomicsWaitAsync',
    ] as const) {
      expect(
        canUseSharedMemoryBus(probeCapabilities(env({ [missing]: false })))
      ).toBe(false);
    }
  });
});

describe('readCapabilityEnv', () => {
  it('reads false for everything in a bare scope', () => {
    expect(readCapabilityEnv({} as typeof globalThis)).toEqual({
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
      hasAtomicsWaitAsync: false,
      hasWebGPU: false,
      hasWebGL2: false,
    });
  });

  it('treats an undefined crossOriginIsolated as not isolated', () => {
    // It is `undefined` rather than `false` in workers on older engines, and a
    // truthiness test there would be reading absence as presence.
    const scope = {
      crossOriginIsolated: undefined,
    } as unknown as typeof globalThis;
    expect(readCapabilityEnv(scope).crossOriginIsolated).toBe(false);
  });

  it('reads a real scope', () => {
    const scope = {
      crossOriginIsolated: true,
      SharedArrayBuffer: function () {},
      Atomics: { waitAsync: () => {} },
      navigator: { gpu: {} },
      document: { createElement: () => ({ getContext: () => ({}) }) },
    } as unknown as typeof globalThis;
    expect(readCapabilityEnv(scope)).toEqual({
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
      hasAtomicsWaitAsync: true,
      hasWebGPU: true,
      hasWebGL2: true,
    });
  });

  it('reports no WebGL2 when the driver refuses the context', () => {
    // The machine that has `WebGL2RenderingContext` and cannot create a context
    // is exactly the machine the static path exists for, so the probe asks for
    // a context rather than checking for the constructor.
    const scope = {
      document: { createElement: () => ({ getContext: () => null }) },
    } as unknown as typeof globalThis;
    expect(readCapabilityEnv(scope).hasWebGL2).toBe(false);
  });

  it('reports no WebGL2 when creating the canvas throws', () => {
    const scope = {
      document: {
        createElement: () => {
          throw new Error('blocked by policy');
        },
      },
    } as unknown as typeof globalThis;
    expect(readCapabilityEnv(scope).hasWebGL2).toBe(false);
  });

  it('does not mistake a non-object navigator.gpu for WebGPU', () => {
    const scope = { navigator: { gpu: null } } as unknown as typeof globalThis;
    expect(readCapabilityEnv(scope).hasWebGPU).toBe(false);
  });
});

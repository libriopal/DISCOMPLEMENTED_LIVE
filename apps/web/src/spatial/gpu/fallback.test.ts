import { describe, expect, it } from 'vitest';

import { probeCapabilities, type CapabilityEnv } from '../capabilities.js';
import {
  chooseRenderPath,
  shouldUseSharedMemory,
  type RenderPath,
} from './fallback.js';

const caps = (overrides: Partial<CapabilityEnv> = {}) =>
  probeCapabilities({
    crossOriginIsolated: true,
    hasSharedArrayBuffer: true,
    hasAtomicsWaitAsync: true,
    hasWebGPU: true,
    hasWebGL2: true,
    ...overrides,
  });

describe('chooseRenderPath', () => {
  it('takes WebGPU when it is there, with nothing to say about it', () => {
    expect(chooseRenderPath(caps())).toEqual({ path: 'webgpu', notice: null });
  });

  it('falls back to WebGL2', () => {
    const choice = chooseRenderPath(caps({ hasWebGPU: false }));
    expect(choice.path).toBe('webgl2');
    expect(choice.notice).toBeTruthy();
  });

  it('falls back to a static view when neither is available', () => {
    expect(
      chooseRenderPath(caps({ hasWebGPU: false, hasWebGL2: false })).path
    ).toBe('static');
  });

  it('prefers WebGPU even when WebGL2 is also present', () => {
    expect(chooseRenderPath(caps({ hasWebGL2: false })).path).toBe('webgpu');
  });

  it('does not let the shared-memory gaps change the render path', () => {
    // The bus and the renderer are independent: an unisolated document still
    // renders on WebGPU, it just copies state between threads to get there.
    expect(
      chooseRenderPath(
        caps({
          crossOriginIsolated: false,
          hasSharedArrayBuffer: false,
          hasAtomicsWaitAsync: false,
        })
      ).path
    ).toBe('webgpu');
  });
});

describe('the fallback notices', () => {
  const notices = [
    chooseRenderPath(caps({ hasWebGPU: false })).notice,
    chooseRenderPath(caps({ hasWebGPU: false, hasWebGL2: false })).notice,
  ];

  it('carries no percentage', () => {
    // Ground rule 2. There is no measured comparison between these paths in
    // this repo, so "reduced detail" is as specific as this code has earned.
    for (const notice of notices) {
      expect(notice ?? '').not.toMatch(/\d\s*%|percent/i);
    }
  });

  it('does not present a supported path as a failure', () => {
    // WebGPU became Baseline in January 2026 and is still absent for a large
    // share of mobile browsers. That machine has not failed and the studio must
    // not tell its owner it has.
    for (const notice of notices) {
      expect(notice ?? '').not.toMatch(/\berror|failed|unsupported browser\b/i);
    }
  });

  it('says what still works', () => {
    // A notice that only names the loss reads as "you are on the broken tier".
    for (const notice of notices) {
      expect(notice ?? '').toMatch(/still/i);
    }
  });
});

describe('shouldUseSharedMemory', () => {
  const paths: RenderPath[] = ['webgpu', 'webgl2'];

  it('uses it on both live paths when the capabilities allow', () => {
    for (const path of paths) {
      expect(shouldUseSharedMemory(caps(), path)).toBe(true);
    }
  });

  it('never uses it on the static path', () => {
    // Nothing there produces a frame, so the ring buffer would be allocated and
    // never filled.
    expect(shouldUseSharedMemory(caps(), 'static')).toBe(false);
  });

  it('agrees with canUseSharedMemoryBus about Atomics.waitAsync', () => {
    // This function briefly answered the same question with a shorter test that
    // omitted `waitAsync`, which would have handed a browser a ring buffer the
    // main thread has no non-blocking way to wait on — `Atomics.wait` throws
    // there.
    for (const path of paths) {
      expect(
        shouldUseSharedMemory(caps({ hasAtomicsWaitAsync: false }), path)
      ).toBe(false);
      expect(
        shouldUseSharedMemory(caps({ crossOriginIsolated: false }), path)
      ).toBe(false);
      expect(
        shouldUseSharedMemory(caps({ hasSharedArrayBuffer: false }), path)
      ).toBe(false);
    }
  });
});

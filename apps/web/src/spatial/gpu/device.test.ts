import { describe, expect, it, vi } from 'vitest';

import {
  DEVICE_LOST_NOTICE,
  acquireDevice,
  onDeviceLost,
  type AdapterLike,
  type DeviceLike,
  type GpuLike,
} from './device.js';
import { type AdapterLimitsLike } from './profile.js';

const GENEROUS: AdapterLimitsLike = {
  maxStorageBufferBindingSize: 2 * 1024 * 1024 * 1024,
  maxBufferSize: 2 * 1024 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupStorageSize: 32768,
};

const FLOOR: AdapterLimitsLike = {
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupStorageSize: 16384,
};

const device = (
  lost: Promise<{ reason: string; message: string }> = new Promise(() => {})
): DeviceLike => ({ limits: GENEROUS, lost, destroy: () => {} });

const adapter = (overrides: Partial<AdapterLike> = {}): AdapterLike => ({
  limits: GENEROUS,
  requestDevice: async () => device(),
  ...overrides,
});

const gpu = (a: AdapterLike | null): GpuLike => ({
  requestAdapter: async () => a,
});

describe('acquireDevice', () => {
  it('reports the absence of WebGPU rather than throwing', () => {
    // The caller is the fallback chooser. A throw here would make "this browser
    // renders on WebGL2" indistinguishable from "the engine crashed".
    return expect(acquireDevice(undefined)).resolves.toEqual({
      ok: false,
      kind: 'no-webgpu',
    });
  });

  it('reports a null adapter', async () => {
    await expect(acquireDevice(gpu(null))).resolves.toEqual({
      ok: false,
      kind: 'no-adapter',
    });
  });

  it('reports a rejected device with its message', async () => {
    const result = await acquireDevice(
      gpu(
        adapter({
          requestDevice: async () => {
            throw new Error('requested limits exceed adapter capability');
          },
        })
      )
    );
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      kind: 'device-rejected',
      message: expect.stringContaining('exceed'),
    });
  });

  it('survives a rejection that is not an Error', async () => {
    const result = await acquireDevice(
      gpu(
        adapter({
          requestDevice: async () => {
            throw 'nope';
          },
        })
      )
    );
    expect(result).toMatchObject({ kind: 'device-rejected', message: 'nope' });
  });

  it('classifies the tier and picks the matching solver', async () => {
    const result = await acquireDevice(
      gpu(adapter({ info: { architecture: 'ampere' } }))
    );
    expect(result).toMatchObject({ ok: true, tier: 'discrete', solver: 'sph' });
  });

  it('classifies from what came back, not from what was asked for', async () => {
    // `powerPreference: 'high-performance'` is a hint the browser may ignore.
    // A dual-GPU laptop that hands back the integrated adapter anyway must be
    // tiered as integrated.
    const result = await acquireDevice(gpu(adapter({ limits: FLOOR })));
    expect(result).toMatchObject({
      ok: true,
      tier: 'integrated',
      solver: 'mls-mpm',
    });
  });

  it('tiers a software fallback adapter as mobile', async () => {
    const result = await acquireDevice(
      gpu(
        adapter({ isFallbackAdapter: true, info: { architecture: 'ampere' } })
      )
    );
    expect(result).toMatchObject({ ok: true, tier: 'mobile' });
  });

  it('normalises an absent adapter.info instead of branching on undefined', async () => {
    // WebGPU restricts what it will say about hardware to limit fingerprinting,
    // so `info` is optional and every field of it may be empty. "The browser
    // told us nothing" has to be the same shape of input as a real answer.
    const result = await acquireDevice(gpu(adapter({ info: undefined })));
    expect(result).toMatchObject({
      ok: true,
      info: { vendor: '', architecture: '', device: '', description: '' },
    });
  });

  it('normalises a partially-populated adapter.info', async () => {
    const result = await acquireDevice(
      gpu(adapter({ info: { vendor: 'intel' } }))
    );
    expect(result).toMatchObject({
      ok: true,
      info: { vendor: 'intel', device: '' },
    });
  });

  it('requests no more than the adapter reported', async () => {
    // Asking for more than an adapter supports rejects the whole device. There
    // is nothing this engine needs above the WebGPU floor, so the request must
    // never be the thing that fails on unusual hardware.
    const requestDevice: AdapterLike['requestDevice'] = vi.fn(async () =>
      device()
    );
    await acquireDevice(gpu(adapter({ limits: FLOOR, requestDevice })));
    const [descriptor] = vi.mocked(requestDevice).mock.calls[0] ?? [];
    expect(descriptor?.requiredLimits).toBeDefined();
    for (const [key, value] of Object.entries(
      descriptor?.requiredLimits ?? {}
    )) {
      expect(value).toBeLessThanOrEqual(FLOOR[key as keyof AdapterLimitsLike]);
    }
  });

  it('asks for the high-performance adapter', async () => {
    const requestAdapter = vi.fn(async () => adapter());
    await acquireDevice({ requestAdapter });
    expect(requestAdapter).toHaveBeenCalledWith({
      powerPreference: 'high-performance',
    });
  });

  it("starts at the tier's particle count", async () => {
    const result = await acquireDevice(gpu(adapter({ limits: FLOOR })));
    expect(result.ok && result.particleCount).toBeGreaterThan(0);
  });
});

describe('onDeviceLost', () => {
  it('runs the handler when the device is lost', async () => {
    let resolve!: (info: { reason: string; message: string }) => void;
    const lost = new Promise<{ reason: string; message: string }>((r) => {
      resolve = r;
    });
    const handler = vi.fn();
    onDeviceLost(device(lost), handler);

    resolve({ reason: 'unknown', message: 'driver reset' });
    await lost;
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({
      reason: 'unknown',
      message: 'driver reset',
    });
  });

  it('stays quiet when the device was destroyed deliberately', async () => {
    // `device.lost` resolves rather than rejects, including on our own
    // teardown. Passing that through fires the recovery path on every
    // navigation, which is how a "GPU lost" notice appears as somebody closes
    // the studio.
    const lost = Promise.resolve({ reason: 'destroyed', message: '' });
    const handler = vi.fn();
    onDeviceLost(device(lost), handler);
    await lost;
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('DEVICE_LOST_NOTICE', () => {
  it('says the simulation state is gone and the work is not', () => {
    // The particle buffer lives only on the GPU by design, so it goes with the
    // device. The blocks and connections are in the CRDT and do not.
    expect(DEVICE_LOST_NOTICE).toMatch(/saved/i);
    expect(DEVICE_LOST_NOTICE).toMatch(/lost|stopped/i);
  });

  it('blames nobody and quotes no figure', () => {
    expect(DEVICE_LOST_NOTICE).not.toMatch(/\d\s*%|percent/i);
    expect(DEVICE_LOST_NOTICE).not.toMatch(
      /\byour (browser|computer) (is|cannot)/i
    );
  });
});

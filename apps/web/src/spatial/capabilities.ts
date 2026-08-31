/**
 * What this browser can actually do for the spatial engine, and — where it
 * cannot — what that costs and what would fix it.
 *
 * The probe reports gaps rather than throwing, because every one of these is
 * survivable: a browser without `SharedArrayBuffer` runs the solver over
 * `postMessage`, and a browser without WebGPU renders the WebGL2 fallback. A
 * throw here would turn a degraded studio into no studio.
 *
 * Two of the gaps are ones the blueprint assumed away, so they are named
 * explicitly rather than folded into a boolean:
 *
 *  - **`Atomics.wait()` cannot be called on the main thread.** It is spec'd to
 *    throw wherever the agent's `[[CanBlock]]` is false, which is every window.
 *    Workers block; the window polls with `Atomics.waitAsync`, which is
 *    Baseline *newly* available (Nov 2025) and therefore probed, not assumed.
 *  - **`SharedArrayBuffer` needs cross-origin isolation**, which this app grants
 *    to `/studio*` and nowhere else (see `isolation.ts`). `crossOriginIsolated`
 *    is reported separately from `sharedArrayBuffer` because they fail for
 *    different reasons and the remedies are different: the first is our
 *    headers, the second is the browser.
 *
 * Everything takes its inputs as an argument so the whole module is testable
 * from node, where none of these globals exist.
 */

/** A capability the spatial engine wants and this environment did not provide. */
export interface CapabilityGap {
  capability: string;
  /** What the engine does instead. Never "it breaks" — that would be a bug. */
  consequence: string;
  /** What would remove the gap, for whoever reads this in a bug report. */
  remedy: string;
}

export interface SpatialCapabilities {
  /** COOP+COEP took effect on this document. Our headers, our problem. */
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  /** The only main-thread-legal way to await a worker's `Atomics.notify`. */
  atomicsWaitAsync: boolean;
  webgpu: boolean;
  webgl2: boolean;
  gaps: CapabilityGap[];
}

/**
 * The globals the probe reads. Injected rather than read off `globalThis` so
 * the tests can describe a Safari, an unisolated document, or a 2019 laptop
 * without needing one.
 */
export interface CapabilityEnv {
  crossOriginIsolated: boolean;
  hasSharedArrayBuffer: boolean;
  hasAtomicsWaitAsync: boolean;
  hasWebGPU: boolean;
  hasWebGL2: boolean;
}

/**
 * Read the real environment. Split from `probeCapabilities` so that the part
 * with the branching lives in a pure function and the part that touches
 * globals has none.
 */
export function readCapabilityEnv(
  scope: typeof globalThis = globalThis
): CapabilityEnv {
  const nav = (scope as { navigator?: { gpu?: unknown } }).navigator;
  return {
    // `crossOriginIsolated` is `undefined` in workers on older engines and in
    // node, and `false` is the correct reading of "not isolated" in both.
    crossOriginIsolated:
      (scope as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    hasSharedArrayBuffer:
      typeof (scope as { SharedArrayBuffer?: unknown }).SharedArrayBuffer ===
      'function',
    hasAtomicsWaitAsync:
      typeof (scope as { Atomics?: { waitAsync?: unknown } }).Atomics
        ?.waitAsync === 'function',
    hasWebGPU: typeof nav?.gpu === 'object' && nav.gpu !== null,
    hasWebGL2: hasWebGL2Context(scope),
  };
}

/**
 * WebGL2 is probed by actually asking for a context, because
 * `'WebGL2RenderingContext' in window` is true on machines whose driver then
 * refuses the context — which is exactly the machine the fallback exists for.
 * The canvas is discarded immediately; contexts are a scarce resource and
 * holding one to answer a yes/no question is how a page runs out of them.
 */
function hasWebGL2Context(scope: typeof globalThis): boolean {
  const doc = (
    scope as {
      document?: { createElement(tag: string): unknown };
    }
  ).document;
  if (!doc) return false;
  try {
    const canvas = doc.createElement('canvas') as {
      getContext(id: string): unknown;
    };
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export function probeCapabilities(env: CapabilityEnv): SpatialCapabilities {
  const gaps: CapabilityGap[] = [];

  if (!env.crossOriginIsolated) {
    gaps.push({
      capability: 'crossOriginIsolated',
      consequence:
        'The solver and the UI exchange particle state by structured clone instead of sharing one buffer, which costs a copy per frame.',
      remedy:
        'This document was served without COOP: same-origin and COEP: require-corp. Those are set for /studio* in apps/web/src/spatial/isolation.ts — reaching the studio by another path, or through a proxy that strips headers, is the usual cause.',
    });
  } else if (!env.hasSharedArrayBuffer) {
    // Isolated and still no SAB means the engine, not our headers. Worth
    // separating: otherwise every such report sends someone to read our CSP.
    gaps.push({
      capability: 'SharedArrayBuffer',
      consequence:
        'Same as an unisolated document: state is copied between threads rather than shared.',
      remedy:
        'The document is cross-origin isolated but the constructor is absent, so this is a browser or enterprise-policy restriction rather than a header problem.',
    });
  }

  if (!env.hasAtomicsWaitAsync) {
    gaps.push({
      capability: 'Atomics.waitAsync',
      consequence:
        'The main thread is notified of new frames by postMessage rather than by waking on the shared lock word.',
      remedy:
        'Atomics.waitAsync became Baseline newly-available in November 2025. Atomics.wait is not a substitute here — it is specified to throw on the main thread.',
    });
  }

  if (!env.hasWebGPU) {
    gaps.push({
      capability: 'WebGPU',
      consequence: env.hasWebGL2
        ? 'Physics runs at reduced particle counts through the WebGL2 fallback path.'
        : 'The simulation does not run; the studio renders a static blueprint view.',
      remedy:
        'WebGPU is Baseline since January 2026. On Linux it is often present but disabled by default, and on iOS it requires version 26.',
    });
  }

  return {
    crossOriginIsolated: env.crossOriginIsolated,
    sharedArrayBuffer: env.hasSharedArrayBuffer,
    atomicsWaitAsync: env.hasAtomicsWaitAsync,
    webgpu: env.hasWebGPU,
    webgl2: env.hasWebGL2,
    gaps,
  };
}

/**
 * True when the shared-memory bus is usable end to end. All three are needed
 * together: an isolated document whose engine lacks `waitAsync` can allocate
 * the buffer but cannot wake the window from it, and a ring buffer nothing
 * wakes is a polling loop with extra steps.
 */
export function canUseSharedMemoryBus(caps: SpatialCapabilities): boolean {
  return (
    caps.crossOriginIsolated && caps.sharedArrayBuffer && caps.atomicsWaitAsync
  );
}

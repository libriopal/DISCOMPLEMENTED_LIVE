/**
 * Studio — the chrono-compiler's client surface. Reached only at `/studio*`
 * (see `App.tsx`), because that path is the one thing `spatial/isolation.ts`
 * isolates: the document has to be fetched at that pathname for COOP/COEP to
 * take effect before this component ever mounts. Rendering this view under
 * the ordinary app shell would not undo that — it would just run the studio
 * unisolated, silently, on every reload that lands on a different route.
 *
 * `gpu/` and `wgsl/` are not imported at the top of this file. They are
 * WebGPU-only, several hundred KB with the shader text, and dead weight for
 * the WebGL2 and static paths — so they load behind `import()`, after the
 * capability probe has already decided they're wanted (G8 bundle isolation).
 */
import { useEffect, useRef, useState } from 'react';
import {
  probeCapabilities,
  readCapabilityEnv,
  type SpatialCapabilities,
} from '../spatial/capabilities.js';
import type { RenderPathChoice } from '../spatial/gpu/fallback.js';
import type { AcquireResult } from '../spatial/gpu/device.js';

type EngineState =
  | { status: 'probing' }
  | { status: 'static'; notice: string | null }
  | { status: 'unavailable'; notice: string }
  | {
      status: 'ready';
      path: RenderPathChoice;
      device: AcquireResult & { ok: true };
    }
  | { status: 'lost'; notice: string };

export function StudioView() {
  const [caps, setCaps] = useState<SpatialCapabilities | null>(null);
  const [engine, setEngine] = useState<EngineState>({ status: 'probing' });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const env = readCapabilityEnv();
      const probed = probeCapabilities(env);
      if (cancelled) return;
      setCaps(probed);

      // fallback.ts is tiny (no WGSL, no device code) but it's still part of
      // the split: importing it eagerly would defeat the point of deciding
      // the path before pulling in anything GPU-shaped.
      const { chooseRenderPath } = await import('../spatial/gpu/fallback.js');
      const path = chooseRenderPath(probed);
      if (cancelled) return;

      if (path.path === 'static') {
        setEngine({ status: 'static', notice: path.notice });
        return;
      }

      if (path.path === 'webgl2') {
        // The WebGL2 solver has no implementation in this tree yet — only the
        // WGSL/WebGPU path does (spatial/wgsl/). Saying otherwise here would
        // be exactly the kind of unfounded claim ground rule 2 exists to
        // block, so this path shows the fallback notice and stops rather than
        // pretending a simulation is running.
        setEngine({
          status: 'unavailable',
          notice:
            `${path.notice ?? ''} (The WebGL2 solver itself is not built yet — this browser will see the static blueprint view until it is.)`.trim(),
        });
        return;
      }

      const { acquireDevice, onDeviceLost, DEVICE_LOST_NOTICE } = await import(
        '../spatial/gpu/device.js'
      );
      const nav = navigator as Navigator & { gpu?: unknown };
      const result = await acquireDevice(
        nav.gpu as Parameters<typeof acquireDevice>[0]
      );
      if (cancelled) return;

      if (!result.ok) {
        const notice =
          result.kind === 'no-webgpu'
            ? 'This browser reported WebGPU support during capability probing but did not have it by the time the studio asked for it.'
            : result.kind === 'no-adapter'
              ? 'No WebGPU adapter was available for this device.'
              : `The GPU device request was rejected: ${result.message}`;
        setEngine({ status: 'unavailable', notice });
        return;
      }

      setEngine({ status: 'ready', path, device: result });
      onDeviceLost(result.device, () => {
        if (!cancelled)
          setEngine({ status: 'lost', notice: DEVICE_LOST_NOTICE });
      });
    }

    boot().catch((err) => {
      if (!cancelled) {
        setEngine({
          status: 'unavailable',
          notice: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--surface-base)',
        color: 'var(--text-primary)',
      }}
    >
      <header
        style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <strong>Studio</strong>
        <EngineStatusBadge engine={engine} />
      </header>

      <div style={{ position: 'relative', flex: 1 }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        {engine.status !== 'ready' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              textAlign: 'center',
            }}
          >
            <p style={{ maxWidth: '480px', color: 'var(--text-secondary)' }}>
              {engineNotice(engine)}
            </p>
          </div>
        )}
      </div>

      {caps && caps.gaps.length > 0 && (
        <footer
          style={{
            padding: '8px 20px',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          {caps.gaps.map((gap) => (
            <div key={gap.capability}>
              <strong>{gap.capability}:</strong> {gap.consequence}
            </div>
          ))}
        </footer>
      )}
    </div>
  );
}

function engineNotice(engine: EngineState): string {
  switch (engine.status) {
    case 'probing':
      return 'Checking what this browser can run…';
    case 'static':
      return engine.notice ?? 'The simulation is not running in this browser.';
    case 'unavailable':
      return engine.notice;
    case 'lost':
      return engine.notice;
    case 'ready':
      return '';
  }
}

function EngineStatusBadge({ engine }: { engine: EngineState }) {
  const label = (() => {
    switch (engine.status) {
      case 'probing':
        return 'Probing…';
      case 'static':
        return 'Static';
      case 'unavailable':
        return 'Unavailable';
      case 'lost':
        return 'Device lost';
      case 'ready':
        return `${engine.path.path} · ${engine.device.tier} · ${engine.device.solver} · ${engine.device.particleCount.toLocaleString()} particles`;
    }
  })();
  return (
    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
      {label}
    </span>
  );
}

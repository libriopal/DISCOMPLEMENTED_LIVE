/**
 * Unified preview component — renders whichever tier lib/preview-strategy.ts
 * selected. Tier 1 (Babel) and Tier 2 (esbuild) render into a sandboxed
 * `<iframe srcDoc>` with a postMessage error bridge; Tier 3 (Sandbox) points
 * the iframe at the real dev server running in the project's container, and
 * reports what that container is doing — see SandboxPreview below. The caller
 * owns the container's lifecycle (hooks/useSandboxPreview) and passes its
 * state down; this component decides nothing about when to start one.
 * This is also what the Coder agent's "run preview" step renders once a
 * founder opens the live preview during the error-feedback loop (Phase 5b) —
 * the automatic loop itself still uses the static lint pass in
 * pipeline/tools/read-logs.ts, since a Durable Object can't run an iframe.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { ProjectFile } from '@bicameral/shared/types';
import {
  selectPreviewTier,
  type PreviewTier,
  type PreviewStrategyOptions,
} from '../lib/preview-strategy.js';
import { useEsbuild } from '../hooks/useEsbuild.js';
import type { PipelineComplexity } from '../lib/cohere.js';
import type { HealthReport } from '../durable-objects/sandbox-health.js';
import { backendEvidence } from '../lib/pipeline-legibility.js';
import {
  buildBabelSrcDoc,
  buildCompileErrorSrcDoc,
  buildEsbuildSrcDoc,
  PREVIEW_MESSAGE_SOURCE,
} from '../lib/preview-srcdoc.js';

let babelModule: Promise<typeof import('@babel/standalone')> | null = null;
function loadBabel() {
  babelModule ??= import('@babel/standalone');
  return babelModule;
}

/**
 * Tier 1: transform one file, then hand the result to the shared document
 * builder.
 *
 * `@babel/standalone` is 2.9 MB and only this tier uses it. Measured on
 * 2026-08-29: importing it at module scope put the whole compiler into
 * GenerationView's chunk, taking it from 120 KB to 3.0 MB — paid by every
 * founder opening the Generation view, including the Tier 3 ones whose preview
 * never touches Babel. Loading it here means the cost lands on the tier that
 * spends it. The promise is cached so switching files does not refetch.
 */
async function babelSrcDoc(entry: ProjectFile): Promise<string> {
  try {
    const Babel = await loadBabel();
    const result = Babel.transform(entry.content, {
      presets: ['react', 'typescript'],
      filename: entry.path.endsWith('.tsx') ? entry.path : `${entry.path}.tsx`,
    });
    return buildBabelSrcDoc(result.code ?? '');
  } catch (err) {
    return buildCompileErrorSrcDoc(
      err instanceof Error ? err.message : 'Babel transform failed'
    );
  }
}

/**
 * What the Tier 3 container is currently doing, as the founder needs to see
 * it. Mirrors hooks/useSandboxPreview's `SandboxStatus` plus the two things
 * only the caller knows: whether a start is in flight, and how to trigger one.
 *
 * `degraded` and `warnings` are here rather than being folded into a single
 * boolean because they mean different things. `degraded` is "this preview is
 * not what the blueprint asked for" — the server the API routes need is not
 * running. `warnings` are specific, nameable shortfalls (an env var declared
 * with no value, a dependency that was dropped). Collapsing them loses exactly
 * the detail that tells a founder whether to wait or to fix something.
 */
export interface SandboxPresentation {
  /** A start request is in flight. */
  starting: boolean;
  running: boolean;
  /** Frontend serving, blueprint's API not. */
  degraded: boolean;
  /**
   * The probe results behind `degraded`, when the health check reached the
   * container. Null means the check could not run — the banner then falls back
   * to the generic wording rather than claiming a measurement it does not have.
   */
  health?: HealthReport | null;
  warnings: string[];
  url: string | null;
  /** Why the last start attempt failed, if one did. */
  error?: string | null;
  /**
   * Set while this project is waiting for a container slot. Distinct from
   * `starting`: waiting is not failing, and it is not progress either. Saying
   * "starting" for ten minutes because the pool is full is the silent
   * downgrade §3.2 rules out.
   */
  queue?: { position: number; queueLength: number; capacity: number } | null;
  onStart?: () => void;
}

export interface PreviewFrameProps {
  files: ProjectFile[];
  entryPoint: string;
  complexity: PipelineComplexity;
  strategy?: PreviewStrategyOptions;
  /** Overrides tier selection — mainly for tests/manual tier switching. */
  tierOverride?: PreviewTier;
  sandbox?: SandboxPresentation;
  onErrors?: (errors: string[]) => void;
}

/**
 * The Tier 3 panel.
 *
 * Every state here is named. The version this replaced rendered the single
 * string "Starting sandbox... (full-stack preview needs a running container —
 * see useSandboxPreview)" for as long as `sandboxUrl` was null, which was
 * forever: nothing on this screen ever started a container. A founder saw a
 * preview that was permanently one moment away from working, and the message
 * pointed them at a source file.
 *
 * The rule this follows is §3.2's: never a silent downgrade. A full-stack
 * preview whose backend did not start still serves its pages, so it looks
 * healthy while every fetch inside it fails — that case gets a banner over a
 * live iframe, not a hidden flag.
 */
function SandboxPreview({ sandbox }: { sandbox?: SandboxPresentation }) {
  const panel: CSSProperties = {
    padding: 'var(--space-4)',
    color: 'var(--text-secondary)',
    fontSize: 13,
    lineHeight: 1.6,
  };

  if (!sandbox) {
    // A caller rendered the sandbox tier without wiring the hook. Say that,
    // rather than showing a spinner for something nobody is starting.
    return (
      <div style={panel}>
        This project needs a full-stack preview, and this screen is not
        connected to one.
      </div>
    );
  }

  if (sandbox.queue) {
    return (
      <div style={panel} role="status">
        <strong style={{ color: 'var(--text-primary)' }}>
          Waiting for a preview container
        </strong>
        <div style={{ marginTop: 8 }}>
          {sandbox.queue.position === 1
            ? 'You are next in line.'
            : `You are number ${sandbox.queue.position} of ${sandbox.queue.queueLength} in line.`}{' '}
          All {sandbox.queue.capacity} preview containers are in use right now.
          This starts on its own as soon as one frees up — nothing to click.
        </div>
      </div>
    );
  }

  if (sandbox.starting) {
    return (
      <div style={panel}>
        <strong style={{ color: 'var(--text-primary)' }}>
          Starting the full-stack preview
        </strong>
        <div style={{ marginTop: 8 }}>
          Booting a container, installing the dependencies your app declares,
          then starting its server. Around 15 seconds, longer with dependencies.
        </div>
      </div>
    );
  }

  if (!sandbox.running || !sandbox.url) {
    return (
      <div style={panel}>
        <strong style={{ color: 'var(--text-primary)' }}>
          Full-stack preview not running
        </strong>
        <div style={{ marginTop: 8 }}>
          This app has API routes, so it needs a real server — more than the
          in-browser preview can run.
        </div>
        {sandbox.error && (
          // Literal colour: this one tracks --danger and is used in the same
          // place the esbuild error pane uses it.
          <div style={{ marginTop: 8, color: '#c0362c' }}>{sandbox.error}</div>
        )}
        {sandbox.onStart && (
          <button
            type="button"
            onClick={sandbox.onStart}
            style={{
              marginTop: 12,
              padding: '6px 12px',
              fontSize: 13,
              cursor: 'pointer',
              color: 'var(--text-primary)',
              background: 'var(--surface-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            Start full-stack preview
          </button>
        )}
      </div>
    );
  }

  // The measured reason, when there is one. `degraded` used to be derived from
  // a port-liveness flag and could only ever produce one sentence; it is now
  // derived from an actual request to an actual declared route, so the banner
  // can say what was asked for and what came back. Falling back to the generic
  // line keeps the banner honest when the probe itself could not be reached —
  // saying nothing there would be the silent downgrade §3.2 rules out.
  const measured =
    sandbox.health?.probes
      .filter((probe) => probe.outcome === 'unhealthy')
      .map((probe) => probe.detail) ?? [];

  const notices = [
    ...(sandbox.degraded
      ? measured.length > 0
        ? measured
        : [
            'The app is serving, but its API server is not running. Anything in the page that calls an API route will fail.',
          ]
      : []),
    ...sandbox.warnings,
  ];

  // §3.4: 'Tier 3 means "a real backend is running" — say that, and show the
  // API route responding.' The health check has always probed a declared route
  // and recorded what it answered; this panel only ever rendered the probes
  // that *failed*. A working backend therefore looked exactly like a Tier 2
  // bundle — an iframe with nothing said about it — and the one thing that
  // makes this tier worth its container was the one thing never shown.
  const evidence = sandbox.degraded
    ? null
    : backendEvidence(sandbox.health?.probes ?? []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
      }}
    >
      {evidence && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: 'var(--space-2) var(--space-3)',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--sur-ink-muted)',
            background: 'var(--sur-ground-2)',
            borderBottom: '1px solid var(--sur-line)',
          }}
        >
          <strong style={{ color: 'var(--sur-ink)' }}>Backend running.</strong>
          {/* The route and its answer, not a green dot. A dot is a claim; this
              is the request that was made and what came back. */}
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {evidence.detail}
          </span>
        </div>
      )}
      {notices.length > 0 && (
        <div
          role="status"
          style={{
            padding: 'var(--space-3)',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--text-primary)',
            background: 'var(--warning-surface, rgba(214, 158, 46, 0.12))',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {notices.map((notice) => (
            <div key={notice}>{notice}</div>
          ))}
        </div>
      )}
      <iframe
        title="preview"
        src={sandbox.url}
        style={{ flex: 1, width: '100%', border: 'none' }}
      />
    </div>
  );
}

export function PreviewFrame({
  files,
  entryPoint,
  complexity,
  strategy,
  tierOverride,
  sandbox,
  onErrors,
}: PreviewFrameProps) {
  const tier = tierOverride ?? selectPreviewTier(complexity, strategy);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { bundle } = useEsbuild(tier === 'esbuild');
  const [srcDoc, setSrcDoc] = useState<string>(
    '<!doctype html><html><body></body></html>'
  );
  const [bundling, setBundling] = useState(false);
  /**
   * The client-side tiers' answer to "is this preview actually working?".
   *
   * Tier 3 gets an HTTP probe (sandbox-health.ts). Tiers 1 and 2 have no
   * server to probe, so the document reports its own outcome and this holds
   * the last one. Null means nothing has been heard yet, which is its own
   * state and must not read as success — a preview that never reports is
   * exactly the silent failure this replaces.
   */
  const [mountNotice, setMountNotice] = useState<string | null>(null);

  const entry = useMemo(
    () => files.find((f) => f.path === entryPoint) ?? files[0],
    [files, entryPoint]
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // Sandboxed srcDoc iframes have an opaque origin, so event.origin
      // isn't checkable — but event.source must be our own iframe's
      // window, not some other frame spoofing the 'bicameral-preview' tag.
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.source !== PREVIEW_MESSAGE_SOURCE) return;
      if (event.data.type === 'error') {
        setMountNotice(null);
        onErrors?.([event.data.message]);
        return;
      }
      // `blank` is not an error: nothing threw. It is the case the platform
      // used to have no way of seeing at all — the bundle evaluated, mounted,
      // and put nothing on the page.
      if (event.data.type === 'blank') {
        setMountNotice(String(event.data.message));
        return;
      }
      if (event.data.type === 'mounted') setMountNotice(null);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onErrors]);

  useEffect(() => {
    if (tier === 'sandbox') return; // iframe src handles it directly
    if (!entry) return;

    // A new document is about to load; whatever the last one reported no
    // longer describes anything on screen.
    setMountNotice(null);

    let cancelled = false;

    if (tier === 'babel') {
      void babelSrcDoc(entry).then((html) => {
        if (!cancelled) setSrcDoc(html);
      });
      return () => {
        cancelled = true;
      };
    }

    setBundling(true);
    bundle(
      files.map((f) => ({ path: f.path, content: f.content })),
      entryPoint
    ).then((result) => {
      if (cancelled) return;
      setBundling(false);
      if (result.errors.length > 0) {
        onErrors?.(result.errors);
        // Literal colour: custom properties do not cross the sandbox boundary,
        // so a token reference here would never resolve. Tracks --danger.
        setSrcDoc(buildCompileErrorSrcDoc(result.errors.join('\n')));
        return;
      }
      setSrcDoc(buildEsbuildSrcDoc(result.code ?? ''));
    });

    return () => {
      cancelled = true;
    };
  }, [tier, entry, files, entryPoint, bundle, onErrors]);

  if (tier === 'sandbox') return <SandboxPreview sandbox={sandbox} />;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {bundling && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            fontSize: 11,
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          bundling...
        </div>
      )}
      {mountNotice && (
        <div
          role="status"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 8,
            padding: '8px 12px',
            fontSize: 12,
            lineHeight: 1.4,
            borderRadius: 6,
            // Literal colours: this sits over the iframe, in the app's own
            // document, so tokens do resolve here — but it tracks --warning
            // deliberately rather than --danger. Nothing failed; the preview
            // is empty, which is a thing to say, not a thing to alarm about.
            color: 'var(--text-primary)',
            background: 'var(--surface-2, #2a2418)',
            border: '1px solid var(--warning, #b8860b)',
          }}
        >
          {mountNotice}
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="preview"
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </div>
  );
}

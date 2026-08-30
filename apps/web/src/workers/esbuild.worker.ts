/**
 * Tier 2 preview bundler — esbuild-wasm running in a dedicated Web Worker
 * (keeps the ~1-2s bundle off the main thread). A virtual-fs plugin
 * resolves relative imports against the in-memory generated files and
 * rewrites bare package imports to esm.sh so the bundle can still load
 * dependencies the coder referenced without a real node_modules install.
 * See lib/preview-strategy.ts for when this tier is selected.
 */
import * as esbuild from 'esbuild-wasm';
import wasmURL from 'esbuild-wasm/esbuild.wasm?url';

export interface WorkerFile {
  path: string;
  content: string;
}

export interface BundleRequest {
  id: string;
  type: 'bundle';
  files: WorkerFile[];
  entryPoint: string;
}

export interface BundleResponse {
  id: string;
  type: 'bundle-result';
  code: string | null;
  errors: string[];
}

let ready: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (!ready) {
    ready = esbuild.initialize({ wasmURL, worker: false });
  }
  return ready;
}

function normalize(path: string): string {
  const parts = path.split('/').filter((p) => p !== '.');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.css', '.json'];

function resolveRelative(
  fromDir: string,
  specifier: string,
  files: Map<string, string>
): string | null {
  const base = normalize(`${fromDir}/${specifier}`.replace(/^\//, ''));
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (files.has(candidate)) return candidate;
    const indexCandidate = `${base}/index${ext}`;
    if (files.has(indexCandidate)) return indexCandidate;
  }
  return null;
}

function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  // The Designer agent consistently emits React components with a plain
  // .js extension containing real JSX (screens/HomeScreen.js, etc. — not
  // a one-off, seen across every generated app tonight). esbuild's 'jsx'
  // loader is a superset of 'js' — it parses JSX when present and behaves
  // identically to 'js' when it isn't — so this is safe for every .js/.jsx
  // file, not just ones we know contain JSX. See
  // bicameral_coder-output-preview-fidelity.md for the bug this fixes.
  return 'jsx';
}

function virtualFsPlugin(files: Map<string, string>): esbuild.Plugin {
  return {
    name: 'virtual-fs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') {
          return { path: args.path, namespace: 'virtual' };
        }
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const resolved = resolveRelative(args.resolveDir, args.path, files);
          if (resolved) return { path: resolved, namespace: 'virtual' };
          return {
            errors: [
              { text: `Cannot resolve "${args.path}" from ${args.resolveDir}` },
            ],
          };
        }
        // Bare specifier (npm package) — no real registry client-side, so
        // point at esm.sh and mark external; the browser fetches it directly.
        return { path: `https://esm.sh/${args.path}`, external: true };
      });

      build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
        const content = files.get(args.path);
        if (content === undefined) {
          return {
            errors: [{ text: `File not found in virtual fs: ${args.path}` }],
          };
        }
        return {
          contents: content,
          loader: loaderFor(args.path),
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

async function handleBundle(request: BundleRequest): Promise<BundleResponse> {
  await ensureInitialized();
  const fileMap = new Map(
    request.files.map((f) => [f.path.replace(/^\//, ''), f.content])
  );

  try {
    const result = await esbuild.build({
      stdin: undefined,
      entryPoints: [request.entryPoint.replace(/^\//, '')],
      bundle: true,
      write: false,
      format: 'esm',
      jsx: 'automatic',
      plugins: [virtualFsPlugin(fileMap)],
      logLevel: 'silent',
    });

    const errors = result.warnings.map((w) => w.text);
    const output = result.outputFiles?.[0]?.text ?? null;
    return { id: request.id, type: 'bundle-result', code: output, errors };
  } catch (err) {
    const esbuildErr = err as {
      errors?: {
        text: string;
        location?: { file: string; line: number } | null;
      }[];
    };
    const messages = esbuildErr.errors?.length
      ? esbuildErr.errors.map((e) =>
          e.location
            ? `${e.location.file}:${e.location.line}: ${e.text}`
            : e.text
        )
      : [err instanceof Error ? err.message : 'Bundle failed'];
    return {
      id: request.id,
      type: 'bundle-result',
      code: null,
      errors: messages,
    };
  }
}

self.onmessage = async (event: MessageEvent<BundleRequest>) => {
  if (event.data.type !== 'bundle') return;
  const response = await handleBundle(event.data);
  (self as unknown as Worker).postMessage(response);
};

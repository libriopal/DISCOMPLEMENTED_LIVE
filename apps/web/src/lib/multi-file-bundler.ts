/**
 * Multi-file esbuild bundler — bundles a set of in-memory files into a
 * single JS string that can be rendered in a sandboxed iframe.
 *
 * Uses esbuild-wasm with an in-memory virtual file system plugin that
 * resolves imports between the generated files and external CDN packages.
 *
 * CRITICAL FIX (F-01): Previously inlined ESM code into <script> and tried
 * to access `exports.default` which doesn't exist in ESM. Now uses blob URL
 * + dynamic import() to properly load the module and access its exports.
 */

import * as esbuild from 'esbuild-wasm';
import type { Plugin } from 'esbuild-wasm';

export interface ProjectFile {
  path: string;
  content: string;
}

export interface BundleResult {
  code: string;
  errors: string[];
}

let initialized = false;

async function ensureEsbuild(): Promise<void> {
  if (initialized) return;
  await esbuild.initialize({
    wasmURL: 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.0/esbuild.wasm',
  });
  initialized = true;
}

const CDN_IMPORTS: Record<string, string> = {
  react: 'https://esm.sh/react@19',
  'react-dom': 'https://esm.sh/react-dom@19',
  'react-dom/client': 'https://esm.sh/react-dom@19/client',
  'react/jsx-runtime': 'https://esm.sh/react@19/jsx-runtime',
};

function createVirtualFsPlugin(files: ProjectFile[]): Plugin {
  const fileMap = new Map<string, string>();
  for (const file of files) {
    const normalized = file.path.replace(/^\.\//, '');
    fileMap.set(normalized, file.content);
    const withoutExt = normalized.replace(/\.(tsx?|jsx?)$/, '');
    fileMap.set(withoutExt, file.content);
  }

  return {
    name: 'virtual-fs',
    setup(build) {
      // Handle CSS imports — return empty content (CSS is handled separately)
      build.onResolve({ filter: /\.css$/ }, (args) => {
        return { path: args.path, namespace: 'css-stub' };
      });
      build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => {
        return { contents: '', loader: 'text' };
      });

      // Handle relative imports (./ or ../)
      build.onResolve({ filter: /^\./ }, (args) => {
        const importer = args.importer.replace(/^\.\//, '');
        const importerDir = importer.includes('/')
          ? importer.substring(0, importer.lastIndexOf('/'))
          : '';
        const resolved = args.path.replace(/^\.\//, '');
        let fullPath = resolved;
        if (importerDir) fullPath = `${importerDir}/${resolved}`;
        const extensions = [
          '',
          '.tsx',
          '.ts',
          '.jsx',
          '.js',
          '/index.tsx',
          '/index.ts',
          '/index.jsx',
          '/index.js',
        ];
        for (const ext of extensions) {
          const tryPath = fullPath + ext;
          if (fileMap.has(tryPath))
            return { path: tryPath, namespace: 'virtual' };
        }
        for (const ext of extensions) {
          const tryPath = resolved + ext;
          if (fileMap.has(tryPath))
            return { path: tryPath, namespace: 'virtual' };
        }
        return { path: resolved, namespace: 'virtual', external: true };
      });

      // Handle bare imports (react, react-dom) — redirect to CDN
      build.onResolve({ filter: /^[a-z@]/ }, (args) => {
        if (CDN_IMPORTS[args.path]) {
          return {
            path: CDN_IMPORTS[args.path],
            namespace: 'cdn',
            external: true,
          };
        }
        return {
          path: `https://esm.sh/${args.path}`,
          namespace: 'cdn',
          external: true,
        };
      });

      // Load virtual files
      build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
        const content = fileMap.get(args.path) ?? '';
        const isTsx = args.path.endsWith('.tsx') || args.path.endsWith('.ts');
        return {
          contents: content,
          loader: isTsx ? 'tsx' : 'js',
          resolveDir: args.path.includes('/')
            ? args.path.substring(0, args.path.lastIndexOf('/'))
            : '/',
        };
      });
    },
  };
}

/**
 * Collect CSS from all .css files in the project and inline as a <style> tag.
 */
function collectCss(files: ProjectFile[]): string {
  const cssFiles = files.filter((f) => f.path.endsWith('.css'));
  return cssFiles.map((f) => f.content).join('\n');
}

/**
 * Wrap bundled ESM code in a self-contained HTML document.
 *
 * Uses blob URL + dynamic import() to properly load the ESM module and
 * access its default export. This is the fix for F-01 — the previous
 * approach inlined the code and tried to access `exports.default` which
 * doesn't exist in ESM context.
 */
function wrapInHtml(jsCode: string, css: string): string {
  // Escape the JS code for safe embedding in a JS string literal
  const escapedCode = JSON.stringify(jsCode);
  const escapedCss = css.replace(/<\/style>/g, '<\\/style>');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${css ? `<style>${escapedCss}</style>` : ''}
  </head>
  <body>
    <div id="root"></div>
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@19",
          "react-dom": "https://esm.sh/react-dom@19",
          "react-dom/client": "https://esm.sh/react-dom@19/client",
          "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime"
        }
      }
    </script>
    <script type="module">
      // F-01 FIX: Use blob URL + dynamic import() to properly load ESM
      // The previous approach inlined the code and tried to access
      // exports.default which doesn't exist in ESM context.
      const code = ${escapedCode};
      const blob = new Blob([code], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);

      try {
        const module = await import(url);
        const React = await import('react');
        const { createRoot } = await import('react-dom/client');

        const Component = module.default;
        if (Component) {
          createRoot(document.getElementById('root')).render(
            React.createElement(Component)
          );
        } else {
          document.getElementById('root').innerHTML =
            '<div style="padding:24px;font-family:system-ui;color:#71717a">' +
            '<h2>No default export found</h2>' +
            '<p>Make sure your entry file has: export default function App() { ... }</p>' +
            '</div>';
        }
      } catch (err) {
        document.getElementById('root').innerHTML =
          '<pre style="color:#c0362c;padding:16px;white-space:pre-wrap;font-family:monospace;font-size:13px">' +
          String(err && err.message ? err.message : err) +
          '</pre>';
        console.error(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    </script>
  </body>
</html>`;
}

export async function bundleProject(
  files: ProjectFile[],
  entryPoint: string
): Promise<BundleResult> {
  if (files.length === 0) {
    return { code: '', errors: ['No files to bundle'] };
  }

  try {
    await ensureEsbuild();
    const entryFile = files.find((f) => f.path === entryPoint) ?? files[0];
    const plugin = createVirtualFsPlugin(files);

    const result = await esbuild.build({
      entryPoints: [entryFile.path],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      plugins: [plugin],
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      define: {
        'process.env.NODE_ENV': '"development"',
      },
    });

    const code = result.outputFiles[0]?.text ?? '';
    const errors = result.errors.map((e) => e.text);
    const css = collectCss(files);
    return { code: wrapInHtml(code, css), errors };
  } catch (err) {
    return {
      code: '',
      errors: [err instanceof Error ? err.message : 'Unknown bundling error'],
    };
  }
}

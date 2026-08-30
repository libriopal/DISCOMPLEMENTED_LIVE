/**
 * Pure helpers for the Tier 3 preview sandbox (Sandbox.ts).
 *
 * Kept out of Sandbox.ts itself only so they are reachable from a plain-node
 * unit test: importing the DO pulls in `cloudflare:workers`, which resolves
 * only under the Workers runtime.
 */
import type { ProjectFile } from '@bicameral/shared/types';
import { findEntryPoint } from '../lib/entry-point.js';

export const DEV_SERVER_PORT = 5173;

/**
 * Where generated files are written and where the dev server is rooted.
 *
 * `Dockerfile.preview` sets `WORKDIR /app`, but `container.exec()` does not
 * honour it — every exec'd process starts in `/`. Measured in production
 * 2026-08-28: `ls -a` from inside an exec listed `/bin`, `/proc`, `/sys` …
 * alongside the generated `index.html` and `src/`, i.e. the Coder's files had
 * been written to the filesystem root and Vite was serving with `root = /`.
 * Vite then crawls and watches that whole tree, which is why a 225-byte static
 * response took 13.5s even on a temporarily upsized "standard-1" instance
 * (1/2 vCPU) and module requests never returned at all. Every exec must `cd`
 * here first.
 */
export const WORKDIR = '/app';

/** Baked into the image at build time — see Dockerfile.preview. */
export const VITE_BIN = '/app/node_modules/.bin/vite';

/**
 * The dev server's output goes to a file inside the container, not to the
 * exec'd process's stdout pipe.
 *
 * `exec()` opens stdout as a pipe, and nothing drains it between `/logs`
 * requests. Vite writes little at startup but writes plenty on the first
 * module request (dependency pre-bundling), and once the pipe's buffer fills,
 * the write blocks and the dev server stops serving. Measured in production
 * 2026-08-27: `/` returned index.html and then `/src/main.jsx` hung
 * indefinitely. A file has no such backpressure, and `/logs` tails it.
 */
export const DEV_SERVER_LOG = '/tmp/vite.log';

/**
 * Origin used for requests forwarded into the container.
 *
 * `container.getTcpPort()` routes by port, not by hostname, but the hostname
 * still becomes the `Host` header the dev server sees — and Vite refuses any
 * host outside `server.allowedHosts`, which no generated project sets. The
 * previous `http://sandbox.internal` earned a 403 with Vite's own body:
 * `Blocked request. This host ("sandbox.internal") is not allowed.` Vite's
 * check hardcodes an exemption for `localhost`, `*.localhost` and bare IP
 * literals, so `localhost` is allowed without touching the generated app's
 * config (which the Coder agent owns and may overwrite).
 */
export const PREVIEW_ORIGIN = 'http://localhost';

/**
 * Origin that addresses the Sandbox DO's own control endpoints, as opposed to
 * the generated app behind it.
 *
 * These used to share one namespace: `Sandbox.fetch` matched `/start`,
 * `/status`, `/destroy`, `/scan` and `/logs` by pathname and proxied
 * everything else. That works only for as long as no generated app defines a
 * route with one of those names — and `/health` and `/status` are two of the
 * most common routes a generated API has. A founder's app serving `/status`
 * would have had its own route answered by this DO's control plane instead,
 * with a JSON body describing a container.
 *
 * Splitting on the hostname removes the class rather than the instance: the
 * proxy path is built from a URL pathname (routes/preview.ts) and can never
 * produce a different host, so no generated route can reach the control plane
 * whatever it is called.
 */
export const SANDBOX_CONTROL_ORIGIN = 'https://sandbox-control';

/**
 * The command that actually starts the preview.
 *
 * The sandbox runs with `enableInternet: false` (Sandbox.start()), so this
 * command must never reach a package registry, and it must not depend on the
 * Coder agent's package.json scripts. `--strictPort` matters: without it Vite
 * silently moves to the next free port, which reads downstream as the same
 * "container is not listening on 5173" failure it was meant to avoid.
 */
export function buildDevServerCommand(port: number = DEV_SERVER_PORT): string {
  return `cd ${WORKDIR} && exec ${VITE_BIN} --host 0.0.0.0 --port ${port} --strictPort > ${DEV_SERVER_LOG} 2>&1`;
}

/**
 * Shell script that receives one generated file's content on stdin.
 *
 * Content is never interpolated — only the path is, and Sandbox.writeFile
 * validates it first. The leading `cd` is what keeps the file inside the Vite
 * root instead of at the filesystem root; see WORKDIR.
 */
export function buildWriteFileScript(path: string): string {
  return `cd ${WORKDIR} && mkdir -p "$(dirname '${path}')" && cat > '${path}'`;
}

/**
 * Readiness probe, run *inside* the container rather than over
 * `getTcpPort().fetch()`.
 *
 * The probe used to be an HTTP request through the container's TCP proxy —
 * the same path live preview traffic takes. Measured in production
 * 2026-08-27: a sandbox whose probe had gone through the proxy answered
 * `/status` and wrote healthy Vite logs ("ready in 330 ms"), but every
 * subsequent proxied request hung until the client timed out, with the Worker
 * ending `canceled` and no exception. Probing from inside the container tests
 * the same thing — is anything listening on 5173 — without spending a proxy
 * connection to do it.
 *
 * Node is the image's base (node:22-slim), so it is always available; curl is
 * deliberately purged from the image.
 */
export function buildPortProbeArgs(port: number = DEV_SERVER_PORT): string[] {
  return [
    'node',
    '-e',
    `const s=require('net').connect(${port},'127.0.0.1');` +
      `s.on('connect',()=>{s.destroy();process.exit(0)});` +
      `s.on('error',()=>process.exit(1));` +
      `setTimeout(()=>process.exit(1),2000);`,
  ];
}

/**
 * Vite serves `/` from index.html and 404s without one, which the preview ping
 * reads as a dead container. Returns a stub when the generated file set has no
 * index.html, or null when it does.
 *
 * The stub is a last resort, not a supported outcome: a file set with no entry
 * module at all still gets one (an HTTP 200 beats a 404 for the founder who is
 * looking at it), but it says so on the page instead of rendering an empty
 * `<div id="root">`. The Coder is supposed to have been sent back to fix this
 * long before here — see lib/entry-point.ts.
 */
export function buildFallbackIndexHtml(files: ProjectFile[]): string | null {
  const entry = findEntryPoint(files);
  if (entry?.kind === 'html') return null;

  const body = entry
    ? `<div id="root"></div>\n    <script type="module" src="/${entry.path}"></script>`
    : `<div id="root"></div>\n    <p>This project has no entry point — no index.html and no main/index module — so there is nothing to run. Regenerate it.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preview</title>
  </head>
  <body>
    ${body}
  </body>
</html>
`;
}

/**
 * The preview container runs with `enableInternet: false` (Sandbox.start()),
 * so anything the dev server needs has to be baked into the image. The
 * original command was `npm install --no-audit --no-fund && npm run dev` —
 * `npm install` had no registry to reach, exited non-zero, and the `&&` meant
 * Vite never launched, so nothing ever bound port 5173. Production run
 * b61499bd (2026-08-27) ended with `Preview unavailable: ... The container is
 * not listening in the TCP address 10.0.0.1:5173`.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@bicameral/shared/types';
import {
  buildDevServerCommand,
  buildFallbackIndexHtml,
  buildPortProbeArgs,
  buildWriteFileScript,
  DEV_SERVER_LOG,
  PREVIEW_ORIGIN,
  WORKDIR,
} from './sandbox-preview.js';

const file = (path: string): ProjectFile => ({
  path,
  content: '',
  language: 'text',
});

describe('buildDevServerCommand()', () => {
  it('never reaches a package registry', () => {
    const cmd = buildDevServerCommand();
    expect(cmd).not.toMatch(/npm (install|ci|i)\b/);
    expect(cmd).not.toMatch(/yarn|pnpm add/);
  });

  it('runs the baked vite binary rather than a package.json script', () => {
    // `npm run dev` depends on the Coder agent having written a package.json
    // with a `dev` script — and the Coder's package.json overwrites the one
    // baked into the image.
    const cmd = buildDevServerCommand();
    expect(cmd).toContain('/app/node_modules/.bin/vite');
    expect(cmd).not.toContain('npm run');
  });

  it('binds all interfaces on the port the proxy fetches', () => {
    // container.getTcpPort(5173) reaches the container over its own address,
    // so a localhost-only bind is unreachable.
    expect(buildDevServerCommand(5173)).toContain('--host 0.0.0.0');
    expect(buildDevServerCommand(5173)).toContain('--port 5173');
  });

  it('writes output to a file instead of the exec stdout pipe', () => {
    // Nothing drains the exec'd process's stdout between /logs requests, and
    // Vite writes plenty on the first module request (dependency
    // pre-bundling). Once the pipe buffer fills, the write blocks and the dev
    // server stops serving — measured in production 2026-08-27, `/` returned
    // index.html and `/src/main.jsx` then hung indefinitely.
    expect(buildDevServerCommand()).toContain(`> ${DEV_SERVER_LOG} 2>&1`);
  });

  it('pins the port with --strictPort', () => {
    // Without it Vite silently moves to the next free port, which reads
    // downstream as the same "not listening on 5173" failure.
    expect(buildDevServerCommand()).toContain('--strictPort');
  });
});

describe('the container working directory', () => {
  // exec() ignores the image's WORKDIR and starts every process in `/`.
  // Production 2026-08-28: generated files landed at the filesystem root and
  // Vite served with root = `/`, crawling and watching /proc, /sys and /usr.
  // A 225-byte static response took 13.5s; module requests never returned.
  it('roots the dev server in the project directory', () => {
    expect(buildDevServerCommand()).toContain(`cd ${WORKDIR} &&`);
  });

  it('writes generated files into the same directory', () => {
    const script = buildWriteFileScript('src/main.jsx');
    expect(script.startsWith(`cd ${WORKDIR} &&`)).toBe(true);
    expect(script).toContain("cat > 'src/main.jsx'");
  });

  it('creates parent directories for nested paths', () => {
    expect(buildWriteFileScript('src/components/Card.jsx')).toContain(
      'mkdir -p'
    );
  });
});

describe('buildPortProbeArgs()', () => {
  it('runs without a shell, so nothing needs quoting', () => {
    expect(buildPortProbeArgs()[0]).toBe('node');
    expect(buildPortProbeArgs()).not.toContain('sh');
  });

  it('connects to the dev server port on the loopback interface', () => {
    const script = buildPortProbeArgs(5173)[2];
    expect(script).toContain("connect(5173,'127.0.0.1')");
    expect(script).toContain('process.exit(0)');
    // A probe that never exits would stall the readiness loop.
    expect(script).toContain('setTimeout');
  });
});

describe('PREVIEW_ORIGIN', () => {
  it('is a host Vite serves without an allowedHosts entry', () => {
    // Vite 403s any Host header outside server.allowedHosts, and no generated
    // project sets one. Its check exempts localhost, *.localhost and bare IP
    // literals — nothing else. Measured against production 2026-08-27 with
    // http://sandbox.internal: `Blocked request. This host
    // ("sandbox.internal") is not allowed.`
    const host = new URL(PREVIEW_ORIGIN).hostname;
    const exempt =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host);
    expect(exempt).toBe(true);
  });
});

describe('buildFallbackIndexHtml()', () => {
  it('returns null when the generated files already include index.html', () => {
    expect(
      buildFallbackIndexHtml([file('index.html'), file('src/main.jsx')])
    ).toBeNull();
    expect(buildFallbackIndexHtml([file('./index.html')])).toBeNull();
  });

  it('points the stub at the generated entry module', () => {
    const html = buildFallbackIndexHtml([
      file('src/App.jsx'),
      file('src/main.jsx'),
    ]);
    expect(html).toContain('<script type="module" src="/src/main.jsx">');
    expect(html).toContain('id="root"');
  });

  it('recognises the usual entry filenames', () => {
    for (const path of ['main.tsx', 'src/index.ts', 'src/main.js']) {
      expect(buildFallbackIndexHtml([file(path)])).toContain(`src="/${path}"`);
    }
  });

  it('still serves a page when there is no recognisable entry', () => {
    // A 404 at / is what the preview ping reads as a dead container, so the
    // stub still has to be a 200 — but it must not be a *blank* 200. A run
    // whose Coder emitted only components used to render an empty
    // <div id="root"> here, which looks identical to a working app that
    // failed to mount.
    const html = buildFallbackIndexHtml([file('README.md')]);
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script');
    expect(html).toContain('no entry point');
  });

  it('ignores a nested file that merely looks like an entry', () => {
    // src/pages/index.jsx is a page, not an entry — nothing loads it.
    const html = buildFallbackIndexHtml([file('src/pages/index.jsx')]);
    expect(html).not.toContain('<script');
  });
});

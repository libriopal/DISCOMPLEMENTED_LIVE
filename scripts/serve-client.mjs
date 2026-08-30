#!/usr/bin/env node
/**
 * Minimal static server for the built client, used as Playwright's webServer.
 *
 * Deliberately not `wrangler dev`: the e2e smoke test asserts that the shipped
 * SPA shell boots and renders, which needs no Worker, no D1, and no secrets —
 * so it stays runnable in CI on a clean checkout. End-to-end coverage of the
 * generation pipeline is separate work and needs the real Worker.
 *
 * Falls back to index.html for unknown paths, matching the
 * `not_found_handling = "single-page-application"` behaviour configured for
 * Workers Assets in wrangler.toml.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, normalize } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist', 'client');
const PORT = Number(process.env['PORT'] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  // normalize() collapses any ../ before the join, so a crafted path cannot
  // escape ROOT even though this only ever serves a build directory.
  const requested = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
  const candidates = [resolve(ROOT, '.' + requested), resolve(ROOT, 'index.html')];

  for (const path of candidates) {
    if (!path.startsWith(ROOT)) continue;
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
      return;
    } catch {
      // try the SPA fallback
    }
  }
  res.writeHead(404).end('not found');
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));

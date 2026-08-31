/**
 * Cross-origin isolation, and the blast radius of turning it on.
 *
 * COOP `same-origin` plus COEP `require-corp` is the precondition for
 * `SharedArrayBuffer`, and it is also the most disruptive pair of headers this
 * app can send: under `require-corp` every cross-origin subresource that does
 * not carry CORP is blocked, and every cross-origin iframe fails to load.
 * Stripe, Turnstile and the preview frames are all in that category.
 *
 * So the headers are scoped to `/studio*` and the tests below are mostly about
 * the boundary rather than about the headers themselves — the interesting
 * failure is not "isolation did not apply", which shows up immediately as a
 * missing `SharedArrayBuffer`, but "isolation applied somewhere it should not
 * have", which shows up as a billing page whose payment form silently never
 * appears.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BLOCKED_SUBRESOURCE_SELECTORS,
  ISOLATED_PATH_PREFIX,
  ISOLATION_HEADERS,
  isIsolatedPath,
  withIsolationHeaders,
} from '../../apps/web/src/spatial/isolation.js';

const repoFile = (path: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../${path}`, import.meta.url)),
    'utf8'
  );

describe('isIsolatedPath', () => {
  it('isolates the studio and its descendants', () => {
    for (const path of [
      '/studio',
      '/studio/',
      '/studio/abc',
      '/studio/project/123/canvas',
    ]) {
      expect(isIsolatedPath(path)).toBe(true);
    }
  });

  it('does not isolate a path that merely starts with the same characters', () => {
    // A bare `startsWith('/studio')` would isolate all of these. `/studios`
    // does not exist today, which is the point: the test is about the route
    // somebody adds next, who will not be thinking about COEP.
    for (const path of [
      '/studios',
      '/studio-preview',
      '/studiolist',
      '/studioX',
    ]) {
      expect(isIsolatedPath(path)).toBe(false);
    }
  });

  it('does not isolate the routes that would break under require-corp', () => {
    // Each of these embeds or loads something cross-origin: Stripe's Elements
    // iframe, Turnstile's widget, the preview container's frame, the marketing
    // site's fonts.
    for (const path of [
      '/',
      '/signin',
      '/billing',
      '/projects',
      '/legal/privacy',
      '/api/auth/callback/github',
      '/preview/abc',
    ]) {
      expect(isIsolatedPath(path)).toBe(false);
    }
  });

  it('does not isolate the empty path or a bare prefix substring', () => {
    expect(isIsolatedPath('')).toBe(false);
    expect(isIsolatedPath('/stud')).toBe(false);
  });
});

describe('ISOLATION_HEADERS', () => {
  it('sends require-corp rather than credentialless', () => {
    // `credentialless` is the friendlier value — it does not require CORP on
    // every subresource — and it is unimplemented in Safari, with no WebKit
    // plan to add it. An unrecognised COEP value parses to nothing, so Safari
    // would drop to the unisolated path with no error and nothing in a
    // Chromium test runner able to notice. `require-corp` costs us the fonts
    // (stripped below) and works everywhere.
    expect(ISOLATION_HEADERS['Cross-Origin-Embedder-Policy']).toBe(
      'require-corp'
    );
  });

  it('sends the opener policy that actually grants isolation', () => {
    // COEP alone does not isolate a document; `crossOriginIsolated` is false
    // without both, and the whole point of the header pair is that one boolean.
    expect(ISOLATION_HEADERS['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('names the studio prefix once', () => {
    expect(ISOLATED_PATH_PREFIX).toBe('/studio');
  });
});

describe('withIsolationHeaders', () => {
  it('adds all three headers on an isolated path', async () => {
    const response = withIsolationHeaders(
      new Response('<!doctype html>', {
        headers: { 'content-type': 'text/html' },
      }),
      '/studio'
    );
    for (const [key, value] of Object.entries(ISOLATION_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }
    expect(await response.text()).toBe('<!doctype html>');
  });

  it('returns an unisolated response untouched', () => {
    const original = new Response('ok');
    expect(withIsolationHeaders(original, '/billing')).toBe(original);
  });

  it('preserves status and existing headers', () => {
    const response = withIsolationHeaders(
      new Response('nope', {
        status: 404,
        statusText: 'Not Found',
        headers: { 'x-existing': 'kept', 'content-type': 'text/html' },
      }),
      '/studio/missing'
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('x-existing')).toBe('kept');
    expect(response.headers.get('content-type')).toBe('text/html');
  });
});

describe('the font strip', () => {
  const indexHtml = repoFile('apps/web/index.html');

  /** The `href` of every cross-origin `<link>` in the document head. */
  const crossOriginHrefs = [...indexHtml.matchAll(/<link\b[\s\S]*?>/g)]
    .map(([tag]) => tag.match(/href\s*=\s*"([^"]+)"/)?.[1] ?? '')
    .filter((href) => /^https?:\/\//.test(href));

  it('finds the cross-origin links it is supposed to be checking', () => {
    // If the regex above stops matching, every assertion below passes
    // vacuously — a green check that never ran.
    expect(crossOriginHrefs.length).toBeGreaterThan(0);
  });

  it('covers every cross-origin link with a selector', () => {
    // A font added to the head without a matching selector does not fail a
    // build. It fails at runtime, on the isolated route only, as a blocked
    // request in a browser nobody is watching.
    const hosts = BLOCKED_SUBRESOURCE_SELECTORS.map(
      (selector) => selector.match(/href\*="([^"]+)"/)?.[1] ?? ''
    );
    expect(hosts.every((host) => host.length > 0)).toBe(true);

    for (const href of crossOriginHrefs) {
      expect(
        hosts.some((host) => href.includes(host)),
        `no BLOCKED_SUBRESOURCE_SELECTORS entry covers ${href}`
      ).toBe(true);
    }
  });

  it('leaves a usable font stack behind when the webfonts are stripped', () => {
    // The strip is only survivable because the tokens name real system faces
    // after the webfont. Without them the studio renders in the browser default
    // and the typography is the first thing a founder notices.
    const tokens = repoFile('apps/web/src/styles/tokens.css');
    const stacks = [...tokens.matchAll(/--font-[\w-]+\s*:\s*([^;]+);/g)].map(
      ([, value]) => value
    );
    expect(stacks.length).toBeGreaterThan(0);
    for (const stack of stacks) {
      expect(stack.split(',').length).toBeGreaterThan(1);
      expect(stack).toMatch(/sans-serif|serif|monospace|system-ui/);
    }
  });
});

describe('the worker wiring', () => {
  const indexTs = repoFile('apps/web/src/index.ts');

  it('applies the isolation headers on the SPA fallback', () => {
    // The SPA serves one `index.html` for every route, so the studio document
    // and the billing document are the same asset response — the pathname is
    // the only thing that separates them, and it has to be read at this seam.
    expect(indexTs).toMatch(/withIsolationHeaders\(/);
    expect(indexTs).toMatch(/stripBlockedSubresources\(/);
  });

  it('strips subresources only on isolated HTML', () => {
    // Rewriting every asset response would put an HTMLRewriter in front of the
    // JS bundle for no reason, and stripping fonts off the marketing page would
    // degrade a page that is not isolated and does not need it.
    const strip = indexTs.match(
      /function stripBlockedSubresources[\s\S]*?\n\}/
    )?.[0];
    expect(strip).toBeDefined();
    expect(strip).toMatch(
      /if \(!isIsolatedPath\(pathname\)\) return response;/
    );
    expect(strip).toMatch(/text\/html/);
  });
});

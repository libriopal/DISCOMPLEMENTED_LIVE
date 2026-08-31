/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Proves the cross-origin isolation boundary against the real Worker.
 *
 * `spatial/isolation.test.ts` checks the path predicate and the header map as
 * pure functions. That is not the same claim as "the Worker sends these headers
 * on `/studio` and does not send them anywhere else" — the SPA fallback serves
 * one `index.html` for every route, so the studio document and the billing
 * document are the same asset response and only the pathname separates them.
 * Getting that seam wrong is invisible to a unit test and visible to a founder
 * as a payment form that never appears: under COEP `require-corp`, a
 * cross-origin iframe without CORP does not load, and Stripe, Turnstile and the
 * preview frames are all in that category.
 *
 * So this file asks the routing stack itself, which is the only thing that can
 * answer.
 */
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { ISOLATION_HEADERS } from '../../src/spatial/isolation.js';

const get = (path: string) =>
  exports.default.fetch(new Request(`http://example.com${path}`));

describe('the isolated route', () => {
  it('sends every isolation header on /studio', async () => {
    const res = await get('/studio');
    for (const [key, value] of Object.entries(ISOLATION_HEADERS)) {
      expect(res.headers.get(key)).toBe(value);
    }
  });

  it('sends them on a studio descendant too', async () => {
    const res = await get('/studio/project/abc');
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe(
      'require-corp'
    );
  });

  it('keeps the app-wide security headers as well', async () => {
    // The isolation wrapper rebuilds the Response, so it is exactly the kind of
    // code that drops headers set upstream of it.
    const res = await get('/studio');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe(
      'strict-origin-when-cross-origin'
    );
  });
});

describe('the unisolated routes', () => {
  // Each of these embeds or loads something cross-origin that `require-corp`
  // would block. They are listed by name rather than generated so that a route
  // added here is a deliberate act.
  const unisolated = [
    '/',
    '/signin',
    '/billing',
    '/projects',
    '/legal/privacy',
    '/studios',
    '/studio-preview',
  ];

  it.each(unisolated)('does not isolate %s', async (path) => {
    const res = await get(path);
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
  });
});

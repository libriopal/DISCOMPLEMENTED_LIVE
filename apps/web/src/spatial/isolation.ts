/**
 * Cross-origin isolation, scoped to the studio and to nothing else.
 *
 * This is the server half of the spatial engine (`capabilities.ts` is the
 * client half that reads the result). It lives here rather than in `lib/`
 * because the reason these headers exist at all is `SharedArrayBuffer`, and
 * whoever comes to change them should land next to the code that needs them.
 *
 * ## Why the scope is a path and not the site
 *
 * `SharedArrayBuffer` requires the document to be cross-origin isolated:
 * `Cross-Origin-Opener-Policy: same-origin` **and**
 * `Cross-Origin-Embedder-Policy: require-corp`. Applying that site-wide would
 * break, from this app's own CSP allowlist, every cross-origin thing it embeds:
 * `js.stripe.com` (billing), `challenges.cloudflare.com` (Turnstile),
 * `static.cloudflareinsights.com`, Google Fonts, and every preview iframe.
 * Those all keep working because they are never served these headers.
 *
 * ## Why `require-corp` and not `credentialless`
 *
 * `credentialless` is the directive that would let the studio keep loading
 * cross-origin subresources. WebKit has said it does not plan to implement it,
 * so on Safari the header parses to nothing and the document is simply not
 * isolated — a silent downgrade to the slow path on one major browser, and one
 * that no test on a Chromium runner would ever notice. `require-corp` is
 * supported everywhere and fails the same way everywhere.
 *
 * ## The cost, stated rather than hidden
 *
 * Under `require-corp` the Google Fonts stylesheet in `index.html` is a no-cors
 * cross-origin subresource with no CORP header, so the browser blocks it. The
 * studio document therefore has that `<link>` (and its preconnects) removed on
 * the way out — leaving it in would mean a guaranteed console error and a
 * render-blocking request that cannot succeed. Studio type falls back to the
 * `ui-sans-serif` / `system-ui` ends of the stacks in `styles/tokens.css`,
 * which is why those stacks have real fallbacks. Self-hosting the three
 * variable fonts removes this entirely and is the follow-up; until then this is
 * a real, visible difference between the studio and the rest of the app.
 */

/**
 * The one isolated surface. A prefix, not a glob, because it has to be
 * comparable against `URL.pathname` in a Worker with no router in scope.
 */
export const ISOLATED_PATH_PREFIX = '/studio';

export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  // Our own subresources are same-origin, which already satisfies COEP. This
  // is set anyway so that the studio's assets cannot be loaded no-cors *by*
  // some other origin — isolation is about what we embed, this is about who
  // embeds us, and they are worth having together.
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * Whether a pathname is inside the isolated surface.
 *
 * Exact match or a `/`-delimited descendant only. `/studios` and
 * `/studio-preview` are deliberately *not* isolated: a prefix test that
 * admitted them would silently isolate any future route that happened to start
 * with those eight characters, which is how a Stripe iframe stops loading for
 * a reason nobody can find.
 */
export function isIsolatedPath(pathname: string): boolean {
  return (
    pathname === ISOLATED_PATH_PREFIX ||
    pathname.startsWith(`${ISOLATED_PATH_PREFIX}/`)
  );
}

/**
 * Element selectors whose subresources `require-corp` would block on the
 * studio document, removed there and only there.
 *
 * Kept as data so `tests/security/isolation.test.ts` can assert that every
 * cross-origin `<link>` in `index.html` is covered by one of them. A font
 * added to the head without a matching selector here would not fail a build —
 * it would fail at runtime, on the isolated route, in the browser, as a blocked
 * request. That test is the only thing that catches it earlier.
 */
export const BLOCKED_SUBRESOURCE_SELECTORS: readonly string[] = [
  'link[href*="fonts.googleapis.com"]',
  'link[href*="fonts.gstatic.com"]',
];

/**
 * Add the isolation headers to a response for an isolated path.
 *
 * Returns the response untouched for every other path, so callers can apply it
 * unconditionally and the "is this isolated" decision stays in one place.
 */
export function withIsolationHeaders(
  response: Response,
  pathname: string
): Response {
  if (!isIsolatedPath(pathname)) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

import { test, expect } from '@playwright/test';

/**
 * Smoke coverage for the shipped SPA shell.
 *
 * The build can succeed while the shell fails to boot — a bad import, a
 * throwing module at load, a missing asset — and nothing downstream would
 * notice, because the crawl of production sees an HTML shell either way. These
 * assert that the bundle actually hydrates and paints, on desktop and at
 * mobile width.
 *
 * The sign-in surface is at `/signin`, not `/`. App.tsx serves the marketing
 * screen to signed-out visitors at the root and routes both CTAs and the nav
 * link to `/signin`; these specs were written before that split and asserted a
 * credential form at `/`. The root is covered by tests/e2e/marketing.spec.ts.
 */

/**
 * Navigations here wait for `domcontentloaded`, not the default `load`.
 *
 * index.html pulls Inter, Space Grotesk and Fira Code from fonts.googleapis.com.
 * Where that host is unreachable — offline sandboxes, restricted CI — the
 * stylesheet request stalls rather than failing fast, the `load` event never
 * fires, and `goto` spends the entire test budget waiting for a font. It shows
 * up as a 30s timeout on whichever spec navigates first, with a page snapshot
 * proving the page had rendered perfectly the whole time; every later spec
 * passes off the HTTP cache. That is a flake in the harness, not a defect in
 * the app.
 *
 * Nothing is relaxed by this: readiness is asserted explicitly below, and the
 * assertions run against the same fully rendered page either way.
 */

test('boots without app errors and paints the sign-in surface', async ({
  page,
  baseURL,
}) => {
  // Uncaught exceptions are always the app's fault.
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));

  // Failed requests are only the app's fault when they are ours. A blocked
  // third-party font CDN (restricted CI networks, offline runs) says nothing
  // about whether the shell works, and asserting on it makes the suite fail
  // for reasons no one can fix in this repo.
  const ownRequestFailures: string[] = [];
  page.on('requestfailed', (r) => {
    if (baseURL !== undefined && r.url().startsWith(baseURL)) {
      ownRequestFailures.push(
        `${r.url()} — ${r.failure()?.errorText ?? 'unknown'}`
      );
    }
  });

  await page.goto('/signin', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  expect(thrown, `uncaught: ${thrown.join(' | ')}`).toEqual([]);
  expect(
    ownRequestFailures,
    `first-party failures: ${ownRequestFailures.join(' | ')}`
  ).toEqual([]);
});

test('renders a usable credential form at /signin', async ({ page }) => {
  // This asserted against `/` until the marketing site landed in front of the
  // logged-out experience. The credential form did not change — it moved, and
  // LoginScreen is still the only place that collects credentials.
  await page.goto('/signin', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
});

test('does not scroll horizontally at mobile width', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
  );
  expect(overflows).toBe(false);
});

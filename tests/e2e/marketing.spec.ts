import { test, expect } from '@playwright/test';

/**
 * Renders the built marketing site and asserts the DESIGN_SPEC acceptance
 * checklist against the real DOM, not the source: section order, the
 * provisional-pricing badge, no quality percentage, and the handoff to the
 * existing auth screen.
 *
 * The unauthenticated app calls /api/auth/* on boot; the static harness has no
 * Worker, so those 401/fail and the app settles into its logged-out state —
 * which is exactly the state under test.
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

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('leads with the hero, not a login form', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Your dev team researches and designs before it writes any code.'
  );
  // The old logged-out surface was a credential form and nothing else.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test('renders every section in the specified order', async ({ page }) => {
  const ids = await page
    .locator('section[id], header.mkt-nav, footer.mkt-footer')
    .evaluateAll((nodes) =>
      nodes.map((n) => n.id || n.className.split(' ')[0] || '')
    );
  expect(ids).toEqual([
    'mkt-nav',
    'how-it-works',
    'boundaries',
    'pricing',
    'trust',
    'mkt-footer',
  ]);
});

test('shows the provisional pricing badge beside the three tiers', async ({
  page,
}) => {
  await expect(
    page.getByText('Early access — subject to change')
  ).toBeVisible();
  for (const price of ['$0', '$29/mo', '$99/mo']) {
    await expect(page.getByText(price, { exact: true })).toBeVisible();
  }
});

test('states no quality percentage anywhere on the page', async ({ page }) => {
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  expect(text).not.toMatch(/\d+(\.\d+)?\s?%/);
  expect(text).not.toMatch(/\bVDR\b/i);
  expect(text).not.toMatch(/\barchitect\b/i);
  // The line that replaced the retired ceiling must still be present.
  expect(text).toContain(
    "we'd rather show nothing than a number we can't stand behind"
  );
});

test('hands off to the existing sign-in screen', async ({ page }) => {
  await page.getByRole('button', { name: 'Start building' }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
});

test('the page can actually scroll to the footer', async ({ page }) => {
  // theme.css sets `html, body { height: 100%; overflow: hidden }` for the
  // fixed IDE shell. The first cut of this page inherited it and could not
  // scroll at all — everything below the hero was unreachable in a real
  // browser. Visibility assertions did not catch it, because Playwright
  // scrolls elements into view even inside an overflow:hidden container, so
  // this drives the document itself.
  const docHeight = await page.evaluate(
    () => document.documentElement.scrollHeight
  );
  const viewport = page.viewportSize()?.height ?? 0;
  expect(docHeight).toBeGreaterThan(viewport);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await expect(page.locator('.mkt-footer')).toBeInViewport();
});

test('leaves no light gap below the last section', async ({ page }) => {
  // The app shell's fixed height left the document taller than the page's own
  // content, so the light body background showed as a band under the footer.
  // What actually matters is that the page covers the whole document — assert
  // that, plus the ground behind it for elastic overscroll.
  // theme.css transitions `body { background }`, so a naive read samples the
  // animation mid-flight — which is how this first failed, with a different
  // in-between grey on every run. Poll until the value stops changing.
  // Sample only once `.mkt` is attached. `:root:has(.mkt) body` is what paints
  // the marketing ground, so before React mounts the body legitimately carries
  // the app's own `--surface-base` — and now that the default theme is
  // parchment rather than void, that boot value is #fafaf9 and trips the
  // near-white guard below. The settle loop broke on the first two equal reads,
  // which during boot are both that boot value, so it was sampling a moment
  // this test was never about. The assertions are unchanged; the moment is.
  await page.locator('.mkt').waitFor({ state: 'attached' });

  const state = await page.evaluate(async () => {
    const read = () => getComputedStyle(document.body).backgroundColor;
    let previous = read();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const current = read();
      if (current === previous) break;
      previous = current;
    }
    return {
      docHeight: document.documentElement.scrollHeight,
      mktHeight: Math.round(
        document.querySelector('.mkt')?.getBoundingClientRect().height ?? 0
      ),
      bodyBg: previous,
    };
  });

  // The marketing page covers the document, to within a sub-pixel rounding.
  expect(Math.abs(state.docHeight - state.mktHeight)).toBeLessThanOrEqual(2);
  // This used to assert the body was NOT near-white:
  //   expect(state.bodyBg).not.toMatch(/rgba?\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}/)
  // which was really asserting "the marketing page is dark". That premise is
  // retired, not evaded — the page now ships a dual theme whose default half is
  // parchment, and its ground is rgb(245, 239, 228), near-white on purpose.
  //
  // The replacement is stricter, not looser: exact equality against the page's
  // own ground. The old regex passed for ANY colour outside the 200-255 band,
  // including a wrong dark one; this passes for exactly one value and is
  // theme-independent, so it holds in void as well as parchment.
  const ground = await page.evaluate(
    () => getComputedStyle(document.querySelector('.mkt')!).backgroundColor
  );
  expect(
    state.bodyBg,
    `body ground matches the marketing ground — ${JSON.stringify(state)}`
  ).toBe(ground);
});

test('does not scroll horizontally at mobile width', async ({ page }) => {
  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
  );
  expect(overflows).toBe(false);
});

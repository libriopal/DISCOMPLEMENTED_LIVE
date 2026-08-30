import { test, expect } from '@playwright/test';

/**
 * Do the webfonts this page pays to download actually apply?
 *
 * The wiring kit reports a defect worth pinning: a surface that loads Space
 * Grotesk, Inter and Fira Code from fonts.googleapis.com while its
 * `--font-*` tokens resolve to `ui-sans-serif, system-ui`. Every byte is
 * fetched and none of it is used, and nothing catches it because the page
 * looks fine — it just does not look like the design.
 *
 * That defect is in the base44 prototype's token sheet, not in this repo (see
 * `docs/palette.md`). This spec exists so it cannot arrive here when the
 * prototype's CSS is ported: it asserts the wiring at both ends, the token
 * naming the family and the browser having the family.
 *
 * Two separate claims, deliberately not one test:
 *   1. the computed `font-family` names the intended family FIRST — pure
 *      token wiring, true offline, and the half that a port can break;
 *   2. `document.fonts.check` says the face is loaded and usable — which
 *      needs fonts.gstatic.com, and is skipped with a reason rather than
 *      passed when that host is unreachable. A green check that never ran is
 *      worse than a red one.
 */

/** Families the design system asks for, and the token each is meant to reach. */
const EXPECTED = [
  { token: '--font-display', family: 'Space Grotesk' },
  { token: '--font-body', family: 'Inter' },
  { token: '--font-mono', family: 'Fira Code' },
] as const;

/**
 * `beforeEach` navigates and stops there.
 *
 * It used to also wait for the `h1`, which made every test in this file
 * depend on the SPA mounting — a route chunk, a 2.9 MB Babel chunk and an
 * iframe. Measured: that made the token test take 12.0s alone and time out
 * inside the full 82-test suite, failing on a heading it never looks at.
 *
 * The wait was not removed to make a slow test pass. It was removed because
 * two of these four tests read `documentElement` and `document.fonts`, which
 * are ready when the stylesheet is, and neither has anything to say about
 * whether React mounted. The two tests that genuinely need a rendered heading
 * wait for it themselves, below.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
});

test('every font token names its webfont before any fallback', async ({
  page,
}) => {
  // The tokens arrive with the stylesheet, not with the app. Poll the first
  // one rather than assuming the CSS has been parsed by the time goto returns.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--font-display')
            .trim()
        ),
      { message: '--font-display is defined by the stylesheet' }
    )
    .not.toBe('');

  for (const { token, family } of EXPECTED) {
    const value = await page.evaluate(
      (name) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue(name)
          .trim(),
      token
    );
    expect(value, `${token} is defined`).not.toBe('');
    // First in the list or it never renders: a fallback ahead of the webfont
    // is the same defect as not naming it at all.
    expect(
      value.replace(/['"]/g, '').split(',')[0]?.trim(),
      `${token} resolves to ${family}`
    ).toBe(family);
  }
});

test('the h1 renders in the display face, not the system stack', async ({
  page,
}) => {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const computed = await page
    .getByRole('heading', { level: 1 })
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(computed.replace(/['"]/g, '')).toMatch(/^Space Grotesk\b/);
});

test('the browser has the faces the page asked for', async ({ page }) => {
  // `fonts.ready` resolves once pending loads settle. Where gstatic is
  // unreachable the faces simply never arrive; report that as unverified
  // rather than as either a pass or an app defect.
  await page.evaluate(() => document.fonts.ready);

  const results = await page.evaluate(
    (families) =>
      families.map((family) => ({
        family,
        // Weight matters. `document.fonts.check('1rem "X"')` asks about
        // weight 400 by default — it answered `false` for Space Grotesk here
        // while the h1 was rendering in it, because the h1 is 700 and only
        // 400/500 had been requested. Checking the weight the page actually
        // renders at is the question worth asking.
        loaded: document.fonts.check(`700 1rem "${family}"`),
      })),
    EXPECTED.map((e) => e.family)
  );

  const loadedAny = results.some((r) => r.loaded);
  test.skip(
    !loadedAny,
    'fonts.gstatic.com unreachable from this environment — font loading NOT verified'
  );

  for (const { family, loaded } of results) {
    expect(loaded, `"${family}" is loaded and usable at 700`).toBe(true);
  }
});

test('no heading is faux-bolded from a weight that was never fetched', async ({
  page,
}) => {
  // The defect this catches: the stylesheets use 400/500/600/700, the font
  // link asked for `wght@400;500`, and Chrome silently synthesised the rest.
  // Nothing errors, nothing looks broken, and the display face is not the one
  // the design specifies.
  //
  // `document.fonts.check('700 1rem "Space Grotesk"')` does NOT catch this and
  // was tried first: check() runs CSS font matching, which happily matches the
  // 500 face for a 700 request and reports it loaded. It answers "can this be
  // rendered", not "is this the weight you asked for". Verified by planting the
  // old two-weight URL back — all four assertions stayed green.
  //
  // The question that does discriminate is whether a face declaring that
  // weight exists at all, so this walks `document.fonts` and reads the ranges.
  // A variable face reports `weight: "400 700"`; a static one reports "500".
  //
  // This one reads the rendered h1, so it waits for the app to mount. The
  // `verdict === null` branch below is the guard against reading too early.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const verdict = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (!h1) return null;
    const weight = Number.parseInt(getComputedStyle(h1).fontWeight, 10);
    const family = getComputedStyle(h1)
      .fontFamily.split(',')[0]!
      .replace(/['"]/g, '')
      .trim();

    const faces: { weight: string; status: string }[] = [];
    let loadedAnything = false;
    document.fonts.forEach((f) => {
      if (f.status === 'loaded') loadedAnything = true;
      if (f.family.replace(/['"]/g, '') === family) {
        faces.push({ weight: f.weight, status: f.status });
      }
    });

    const covers = faces.some(({ weight: w }) => {
      const [lo, hi] = w.split(/\s+/).map(Number);
      if (lo === undefined || Number.isNaN(lo)) return false;
      return weight >= lo && weight <= (hi ?? lo);
    });

    return { weight, family, faces, covers, loadedAnything };
  });

  expect(verdict).not.toBeNull();
  // Offline, no face loads at all and this says nothing about the app.
  test.skip(
    verdict!.loadedAnything === false,
    'fonts.gstatic.com unreachable from this environment — weight coverage NOT verified'
  );
  expect(
    verdict!.covers,
    `h1 renders "${verdict!.family}" at ${verdict!.weight}, but the only faces served for it are ` +
      `${verdict!.faces.map((f) => f.weight).join(' / ') || '(none)'} — Chrome is synthesising that weight`
  ).toBe(true);
});

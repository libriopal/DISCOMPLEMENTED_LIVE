import { test, expect, type Page } from '@playwright/test';

/**
 * The mobile surface, measured — 390 x 844 with touch emulation.
 *
 * These assertions came out of measuring the rendered page, not out of reading
 * the wiring kit's audit. That distinction produced a different answer: the kit
 * reports "10 controls under 44px on the home page", a 350x33 drawer link and a
 * 52x38 `Open menu` button. This repo's marketing nav has no drawer and no menu
 * button — those are the prototype's markup — and the home page had THREE
 * undersized controls, all failing on width with the height already right.
 *
 * The exclusions below are the interesting part of the file. Each one is a
 * shape where 44px is genuinely not the requirement, and each is narrow enough
 * that a real defect cannot hide inside it.
 */

const MIN_TARGET = 44;
const ROUTES = ['/', '/signin', '/legal/terms'] as const;

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function settle(page: Page, route: string) {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  // The authed shell and the legal pages fetch before they paint; the marketing
  // page does not. Waiting on a control rather than a heading covers both.
  await page.waitForFunction(
    () => document.querySelectorAll('a, button, input').length > 0
  );
}

test.describe('every route', () => {
  for (const route of ROUTES) {
    test(`${route} does not scroll horizontally`, async ({ page }) => {
      await settle(page, route);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      // Not "is there a scrollbar" — an element pushed past the right edge can
      // be clipped by an ancestor and still be unreachable. This is the width
      // the document believes it needs.
      expect(
        scrollWidth,
        `${route} scrollWidth vs viewport`
      ).toBeLessThanOrEqual(clientWidth);
    });

    test(`${route} sizes every standalone control for a finger`, async ({
      page,
    }) => {
      await settle(page, route);

      const undersized = await page.evaluate((min) => {
        const out: string[] = [];
        const selector =
          'a, button, [role="button"], input, select, textarea, summary';

        for (const el of Array.from(document.querySelectorAll(selector))) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue; // not rendered

          // EXCLUSION 1 — a link inside running text. Padding one to 44px
          // wrecks the leading and makes a paragraph of links overlap; WCAG
          // 2.5.5 exempts targets in a sentence for exactly this reason.
          const inProse = el.closest('p, li, label') && el.tagName === 'A';
          if (inProse) continue;

          // EXCLUSION 2 — a checkbox or radio wrapped in its own label. The
          // activation area is the label, so the box's own 13px is not the
          // target. Verified, not assumed: if the label is under 44px this
          // falls through and reports.
          const input = el as HTMLInputElement;
          if (input.type === 'checkbox' || input.type === 'radio') {
            const label = el.closest('label');
            if (label) {
              const lr = label.getBoundingClientRect();
              if (lr.width >= min && lr.height >= min) continue;
            }
          }

          if (rect.width < min || rect.height < min) {
            const label = (el.textContent ?? '').trim().slice(0, 30);
            out.push(
              `<${el.tagName.toLowerCase()} class="${el.className}"> "${label}" ` +
                `${Math.round(rect.width)}x${Math.round(rect.height)}`
            );
          }
        }
        return out;
      }, MIN_TARGET);

      expect(undersized, `undersized controls on ${route}`).toEqual([]);
    });
  }
});

test('the viewport meta lets the page scale', async ({ page }) => {
  await settle(page, '/');
  const content = await page
    .locator('meta[name="viewport"]')
    .getAttribute('content');
  expect(content).toContain('width=device-width');
  // `user-scalable=no` and a capped `maximum-scale` both break pinch zoom,
  // which is an accessibility failure regardless of how tidy it makes the
  // layout. Asserting their absence, not the presence of anything.
  expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/);
  expect(content).not.toMatch(/maximum-scale\s*=\s*1/);
});

test('no input can trigger the iOS zoom trap', async ({ page }) => {
  // Mobile Safari zooms in on a focused input under 16px and does not zoom back
  // out. Measured before the fix: the sign-in form's four text inputs were
  // 14px, set by an INLINE style — which no stylesheet rule can beat without
  // `!important`, so the site-wide floor in dual-theme.css was in place and
  // losing silently. That is the case for measuring the page over reading it.
  await settle(page, '/signin');

  const sizes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((el) => {
        const t = (el as HTMLInputElement).type;
        return t !== 'checkbox' && t !== 'radio';
      })
      .map((el) => ({
        type: (el as HTMLInputElement).type,
        px: Number.parseFloat(getComputedStyle(el).fontSize),
      }))
  );

  expect(
    sizes.length,
    'the sign-in form has text inputs to check'
  ).toBeGreaterThan(0);
  for (const { type, px } of sizes) {
    expect(px, `input[type=${type}] font-size`).toBeGreaterThanOrEqual(16);
  }
});

test('the theme menu opens, escapes, and returns focus', async ({ page }) => {
  // The kit asks for this against a mobile nav drawer. There is no drawer in
  // this repo — the marketing nav lays out flat at 390px and the measurement
  // above confirms it does not overflow. The theme picker is the one menu on
  // the signed-out surface, so it is what this covers; when the prototype's
  // drawer is ported, this test is the shape to copy.
  await settle(page, '/');

  const trigger = page.getByRole('button', { name: /Change theme/i });
  await trigger.tap();

  const menu = page.getByRole('menu', { name: 'Theme' });
  await expect(menu).toBeVisible();

  // Focus moves INTO the menu, or a keyboard user is left behind on the page.
  await expect(
    menu.locator(':focus'),
    'focus lands inside the open menu'
  ).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger, 'focus returns to the trigger').toBeFocused();
});

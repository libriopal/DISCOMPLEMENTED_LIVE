import { test, expect, type Page } from '@playwright/test';

/**
 * The three theme states, in a real browser.
 *
 * `contrast.test.ts` proves the colours are legible. It reads the stylesheet as
 * text and cannot tell whether any of it reaches a document — a theme can be
 * perfectly contrasted and still never apply. This is the other half.
 *
 * Three states, because two is the common bug: explicit light, explicit dark,
 * and system. A picker with only the first two is a one-way door — try dark
 * once and your machine's preference is overridden forever, silently.
 *
 * Note what these assert on. `data-theme` is the mechanism; the computed
 * background of `body` is the outcome. Asserting only the attribute would pass
 * against a stylesheet that defines nothing for that attribute's value, which
 * is exactly the failure worth catching.
 */

const STORAGE_KEY = 'bicameral-theme';

/** Seed the persisted preference before any of the app's script runs. */
async function withStoredTheme(page: Page, value: string | null) {
  await page.addInitScript(
    ([key, stored]) => {
      try {
        if (stored === null) localStorage.removeItem(key!);
        else localStorage.setItem(key!, stored!);
      } catch {
        /* privacy mode — the test below will report the real behaviour */
      }
    },
    [STORAGE_KEY, value] as const
  );
}

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** rgb() → relative luminance, so "is this dark" is measured, not eyeballed. */
async function bodyLuminance(page: Page): Promise<number> {
  const rgb = await bodyBackground(page);
  const parts =
    rgb
      .match(/\d+(\.\d+)?/g)
      ?.slice(0, 3)
      .map(Number) ?? [];
  expect(parts.length, `body background is a colour, got "${rgb}"`).toBe(3);
  const [r, g, b] = parts as [number, number, number];
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The body must be painted with a token, not left transparent. A transparent
// body borrows whatever is behind it, which is how a "dark theme" ends up with
// a white flash on overscroll.
async function expectPainted(page: Page) {
  const bg = await bodyBackground(page);
  expect(bg, 'body has an explicit background').not.toBe('rgba(0, 0, 0, 0)');
  expect(bg, 'body has an explicit background').not.toBe('transparent');
}

test.describe('explicit light', () => {
  test.use({ colorScheme: 'dark' }); // the OS says dark; the choice must win

  test('renders light and beats the system preference', async ({ page }) => {
    await withStoredTheme(page, 'light');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    expect(await page.getAttribute('html', 'data-theme')).toBe('light');
    await expectPainted(page);
    expect(await bodyLuminance(page)).toBeGreaterThan(0.5);
  });
});

test.describe('explicit dark', () => {
  test.use({ colorScheme: 'light' }); // and the mirror image

  test('renders dark and beats the system preference', async ({ page }) => {
    await withStoredTheme(page, 'dark');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    await expectPainted(page);
    expect(await bodyLuminance(page)).toBeLessThan(0.1);
  });
});

test.describe('system default, nothing stored', () => {
  test.use({ colorScheme: 'dark' });

  test('follows the OS to dark', async ({ page }) => {
    await withStoredTheme(page, null);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await bodyLuminance(page)).toBeLessThan(0.1);
  });
});

test.describe('system default, explicitly chosen', () => {
  test.use({ colorScheme: 'light' });

  test('follows the OS to light', async ({ page }) => {
    // The literal 'system' — the state a reader gets back to after trying dark.
    // It must behave identically to having stored nothing at all.
    await withStoredTheme(page, 'system');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await bodyLuminance(page)).toBeGreaterThan(0.5);
  });
});

test.describe('the toggle', () => {
  test('is visible signed out', async ({ page }) => {
    // It used to live only in the signed-in shell, which left the one surface
    // carrying the palette with no way to change it.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('button', { name: /Change theme/i })
    ).toBeVisible();
  });

  test('persists the choice across a reload', async ({ page }) => {
    // Deliberately NOT seeded. `addInitScript` runs on every navigation
    // including the reload, so seeding here would overwrite the choice being
    // tested and fail for a reason that has nothing to do with the app — it
    // did, first time. Starting from the default is also the truer test: this
    // is a reader arriving fresh and picking a theme.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /Change theme/i }).click();
    await page.getByRole('menuitemradio', { name: /^Dark$/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Survives the round trip, and survives it without a flash: theme-init.js
    // stamps before React, so the attribute is already right at first paint.
    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    expect(await bodyLuminance(page)).toBeLessThan(0.1);
  });

  test('persists System as System, not as what it resolved to', async ({
    page,
  }) => {
    // The defect this catches: storing the RESOLVED theme instead of the
    // preference. It looks identical today and silently converts a system
    // follower into an explicit chooser, so the next OS switch does nothing.
    await withStoredTheme(page, 'dark');
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /Change theme/i }).click();
    await page.getByRole('menuitemradio', { name: /^System$/ }).click();

    const stored = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEY
    );
    expect(stored).toBe('system');
  });
});

test.describe('no token is undefined in either theme', () => {
  // A token defined ONLY inside `@media (prefers-color-scheme: dark)` resolves
  // to the empty string for everyone who has chosen explicitly, and CSS fails
  // silently: the property is simply dropped and the element inherits. This
  // walks the role tokens in each theme and demands a value for every one.
  const ROLE_TOKENS = [
    '--sur-ground',
    '--sur-ground-2',
    '--sur-ground-3',
    '--sur-ground-deep',
    '--sur-ink',
    '--sur-ink-muted',
    '--sur-ink-faint',
    '--sur-contour',
    '--sur-contour-bright',
    '--sur-benchmark',
    '--sur-benchmark-bright',
    '--sur-checkpoint',
    '--sur-checkpoint-bright',
    '--sur-line',
    '--sur-line-strong',
    '--sur-on-signal',
    '--lattice-opacity',
  ];

  for (const theme of ['light', 'dark'] as const) {
    test(`every role token resolves in ${theme}`, async ({ page }) => {
      await withStoredTheme(page, theme);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const resolved = await page.evaluate((tokens) => {
        const style = getComputedStyle(document.documentElement);
        return tokens.map((t) => [t, style.getPropertyValue(t).trim()]);
      }, ROLE_TOKENS);

      for (const [token, value] of resolved) {
        expect(value, `${token} resolves under data-theme="${theme}"`).not.toBe(
          ''
        );
      }
    });
  }
});

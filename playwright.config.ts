import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the built client.
 *
 * `test:e2e` was previously `playwright test` with neither a config, a spec,
 * nor `@playwright/test` installed — so the leg failed on a missing runner and
 * `pnpm test:all` could never reach a real verdict.
 *
 * PLAYWRIGHT_BROWSERS_PATH is respected when set (CI images and sandboxes
 * commonly preinstall Chromium), so no download is forced.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] !== undefined ? 1 : 0,
  reporter: process.env['CI'] !== undefined ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    // Sandboxes and hardened CI images often preinstall a Chromium whose build
    // number does not match the one this Playwright release expects, and
    // cannot fetch the matching one. Point PLAYWRIGHT_CHROMIUM_PATH at the
    // existing binary there; normal environments leave it unset and use the
    // browser `playwright install` provides.
    ...(process.env['PLAYWRIGHT_CHROMIUM_PATH'] !== undefined
      ? {
          launchOptions: {
            executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'],
          },
        }
      : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    // Build, then serve. `serve-client.mjs` serves apps/web/dist/client and
    // does not produce it, so a command that only served graded whatever
    // artifact happened to be on disk. That is not a slow test — it is a leg
    // that can pass against code that was never built: the p1 marketing merge
    // came out green on a dist from before the merge, and the three specs that
    // did fail failed against the superseded component.
    //
    // `reuseExistingServer` is false for the same reason. An already-listening
    // server is serving an already-stale build, and reusing it skips the build
    // that would have refreshed it — the convenience and the defect are the
    // same behaviour.
    command: 'pnpm build && node scripts/serve-client.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

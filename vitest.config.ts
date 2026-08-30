import { defineConfig } from 'vitest/config';

// Root config so `pnpm test:unit` (vitest run, no --config flag) picks up
// workspace test files — e.g. apps/web/src/**/*.test.ts. Playwright owns
// tests/e2e/** via `pnpm test:e2e`, so it's excluded here.
// apps/web/tests/integration/** runs under the Workers runtime via
// vitest.integration.config.ts (`pnpm test:integration`) — it needs the
// cloudflareTest plugin, so it must NOT also run under this plain-node config.
export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/e2e/**',
      'apps/web/tests/integration/**',
    ],
  },
});

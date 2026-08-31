import path from 'node:path';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs apps/web/tests/integration/** inside the actual Workers runtime
// (Miniflare) against the real wrangler.toml bindings — real D1 (migrated
// fresh per run), real Durable Object bindings — rather than mocking module
// boundaries the way packages/cohere/src/*.test.ts does. Targets the auth
// boundary (requireAuth in src/lib/require-auth.ts) and webhook-secret
// routes first, since those are security-relevant and were previously
// exercised only by hand.
export default defineConfig({
  test: {
    include: ['apps/web/tests/integration/**/*.test.ts'],
    setupFiles: ['./apps/web/tests/integration/setup.ts'],
  },
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(import.meta.dirname, 'migrations');
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: './apps/web/wrangler.toml' },
        miniflare: {
          bindings: {
            // Test-only binding consumed by tests/integration/setup.ts to
            // apply migrations/*.sql before each file's tests run.
            TEST_MIGRATIONS: migrations,
            // Real secrets are set via `wrangler secret put` and don't exist
            // locally — stub the ones the auth boundary touches so
            // createAuth()/requireAuth() don't throw on missing config
            // before ever reaching the assertions under test.
            BETTER_AUTH_SECRET: 'test-secret',
            GITHUB_OAUTH_CLIENT_ID_DEV: 'test-client-id',
            GITHUB_OAUTH_CLIENT_SECRET_DEV: 'test-client-secret',
            GITHUB_OAUTH_CLIENT_ID_PROD: 'test-client-id',
            GITHUB_OAUTH_CLIENT_SECRET_PROD: 'test-client-secret',
            SECURITY_GATE_WEBHOOK_SECRET: 'test-webhook-secret',
            // simulation-ingest.ts compares the header against this. Without
            // a value both the right secret and the wrong one fail, so the
            // rejection test would pass for the wrong reason.
            SIMULATION_INGEST_SECRET: 'test-simulation-secret',
            // The FluxyChat callback secret (routes/chat.ts webhooks). Set for
            // the same reason as the line above: with no value configured,
            // verifyWebhookKey fails closed on every input, so the "wrong key
            // is refused" assertions would pass without the check working.
            FLUXYCHAT_WEBHOOK_SECRET: 'test-fluxy-webhook-secret',
          },
        },
      };
    }),
  ],
});

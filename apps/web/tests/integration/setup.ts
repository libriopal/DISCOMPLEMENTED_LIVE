/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from 'cloudflare:test';

// TEST_MIGRATIONS is populated in vitest.integration.config.ts via
// readD1Migrations(migrationsPath) — see that file for why.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

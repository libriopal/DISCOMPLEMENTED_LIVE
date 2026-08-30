// Augments the ambient Cloudflare.Env / Cloudflare.Exports types that
// `cloudflare:test` and `cloudflare:workers` rely on (normally produced by
// `wrangler types`, which this project doesn't run — see src/env.ts's own
// hand-written Env). Scoped to tests/integration/ only.
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as AppEnv } from '../../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('../../src/index.js');
    }
  }
}

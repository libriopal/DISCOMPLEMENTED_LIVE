/**
 * Global request middleware — emergency shutdown / maintenance mode gate
 * plus Analytics Engine telemetry, per @agent_docs/admin-panel.md
 * "Telemetry Middleware". Mounted before route handlers in index.ts so a
 * shutdown/maintenance flag short-circuits everything except /api/admin
 * (the panel that clears the flag) and /api/health (uptime probes).
 */
import { createMiddleware } from 'hono/factory';
import type { Env } from '../env.js';
import type { AuthVariables } from './require-auth.js';

const EXEMPT_PREFIXES = ['/api/admin', '/api/health', '/api/auth'];

export const telemetryMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: Partial<AuthVariables>;
}>(async (c, next) => {
  const exempt = EXEMPT_PREFIXES.some((p) => c.req.path.startsWith(p));

  if (!exempt) {
    const [shutdown, maintenance] = await Promise.all([
      c.env.CONFIG_KV.get('EMERGENCY_SHUTDOWN'),
      c.env.CONFIG_KV.get('MAINTENANCE_MODE'),
    ]);
    if (shutdown === 'true') {
      return c.json({ error: 'System under emergency maintenance' }, 503);
    }
    if (maintenance === 'true') {
      return c.json({ error: 'System under maintenance' }, 503);
    }
  }

  const start = performance.now();
  await next();
  const duration = performance.now() - start;

  c.executionCtx.waitUntil(
    (async () => {
      try {
        c.env.ANALYTICS_ENGINE.writeDataPoint({
          blobs: [c.req.path, c.req.method, c.get('userId') ?? 'anonymous'],
          doubles: [duration, c.res.status],
          indexes: [c.req.path],
        });
      } catch (err) {
        // Telemetry is best-effort (must never fail the request it's
        // measuring), but a write failure is still worth surfacing —
        // silently eating it would hide a real misconfiguration (e.g. AE
        // binding missing in an environment that expects it) behind an
        // empty admin panel with no error anywhere.
        console.error('Analytics Engine write failed', err);
      }
    })()
  );
});

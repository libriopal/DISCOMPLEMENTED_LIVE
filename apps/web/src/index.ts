/**
 * Bicameral — @bicameral/web Cloudflare Workers entry point.
 * Mounts auth + the full API surface (pipeline, generate, research,
 * projects, lattice, usage, preview, admin, chat, value assurance).
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { BicameralError } from '@bicameral/shared/errors';
import type { Env } from './env.js';
import type { AuthVariables } from './lib/require-auth.js';
import { requireAuth } from './lib/require-auth.js';
import { telemetryMiddleware } from './lib/telemetry.js';
import { authRoutes } from './routes/auth.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { generateRoutes } from './routes/generate.js';
import { researchRoutes } from './routes/research.js';
import { projectsRoutes } from './routes/projects.js';
import { latticeRoutes } from './routes/lattice.js';
import { usageRoutes } from './routes/usage.js';
import { settingsRoutes } from './routes/settings.js';
import { previewRoutes } from './routes/preview.js';
import { adminRoutes } from './routes/admin.js';
import { chatRoutes, chatWebhookRoutes } from './routes/chat.js';
import { securityGateWebhookRoutes } from './routes/security-gate-webhook.js';
import { billingRoutes, billingWebhookRoutes } from './routes/billing.js';
import {
  CREDIT_PACKAGES,
  TIER_SUBSCRIPTION_PRICES,
} from '@bicameral/shared/constants';
// Value Assurance routes
import { valueRoutes } from './routes/value.js';
import { costHudRoutes } from './routes/cost-hud.js';
import { eiccaRoutes, eiccaWebhookRoutes } from './routes/eicca.js';
import { glassEngineRoutes } from './routes/glass-engine.js';
import { vdrRoutes } from './routes/vdr.js';
import { simulationIngestRoutes } from './routes/simulation-ingest.js';
import { simulationRoutes } from './routes/simulation.js';
import { entitlementsRoutes } from './routes/entitlements.js';
import { tripwiresRoutes } from './routes/tripwires.js';
import { dunningRoutes } from './routes/dunning.js';
import { preferencesRoutes } from './routes/preferences.js';
import { healthRoutes } from './routes/health.js';
import { deployRoutes } from './routes/deploy.js';
import { figmaRoutes } from './routes/figma.js';
import { genomeRoutes } from './routes/genome.js';
import { glaasRoutes } from './routes/glaas.js';
import { userEventsRoutes } from './routes/user-events.js';
import { handleCron } from './lib/cron-handler.js';
import {
  BLOCKED_SUBRESOURCE_SELECTORS,
  isIsolatedPath,
  withIsolationHeaders,
} from './spatial/isolation.js';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use(logger());
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = [
        'https://discomplemented.com',
        'https://www.discomplemented.com',
        'https://bicameral.johnathanallen1998.workers.dev',
        'https://bicameral-staging.johnathanallen1998.workers.dev',
      ];
      return allowed.includes(origin ?? '') ? origin : null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);
// A5: Security headers — CSP, X-Frame-Options, HSTS, etc.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );
  c.header(
    'Permissions-Policy',
    'camera=(), microphone=(self), geolocation=()'
  );
  // CSP: allow inline styles (Vite/React need them), scripts from self + Google Fonts,
  // images from self + data: + R2, connect to self + Cohere API
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://fonts.googleapis.com https://static.cloudflareinsights.com https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https: blob:",
      "connect-src 'self' https://api.cohere.com https://api.you.com https://api.stripe.com https://cloudflareinsights.com",
      "frame-src 'self' https://js.stripe.com https://challenges.cloudflare.com",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
});

app.use('*', telemetryMiddleware);

app.onError((err, c) => {
  if (err instanceof BicameralError) {
    return c.json(
      { error: err.message, details: err.code },
      err.statusCode as never
    );
  }
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

// 404 handler for API routes — returns JSON, not SPA HTML
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404, {
      'Cache-Control': 'no-store',
    });
  }
  // SPA fallback — serve static assets with security headers.
  //
  // The studio additionally gets cross-origin isolation, and its document has
  // the cross-origin font links stripped because `require-corp` blocks them
  // anyway. Both are keyed on the request path rather than on the asset, since
  // the SPA fallback hands back the same index.html for every route.
  const pathname = new URL(c.req.url).pathname;
  const response = c.env.ASSETS.fetch(c.req.raw);
  return response.then((r: Response) =>
    withIsolationHeaders(
      stripBlockedSubresources(withSecurityHeaders(r), pathname),
      pathname
    )
  );
});

app.get('/api/healthz', (c) =>
  c.json({
    status: 'ok',
    version: '1.0.0',
    environment: c.env.ENVIRONMENT || 'development',
  })
);

// Auth is unauthenticated by definition (it establishes the session).
app.route('/api/auth', authRoutes);

// The FluxyChat Worker calls this back directly (not a Bicameral session)
// to execute the support agent's get_pipeline_status tool — it verifies
// its own shared secret instead of a session cookie/virtual key. See
// routes/chat.ts and lib/fluxychat.ts.
app.route('/api/chat/webhook', chatWebhookRoutes);

// .github/workflows/security-gate.yml calls these back directly (not a
// Bicameral session) — it verifies its own shared secret instead. See
// routes/security-gate-webhook.ts.
app.route('/api/security-gate', securityGateWebhookRoutes);

// Stripe calls this back directly (not a Bicameral session) — it verifies
// the `Stripe-Signature` header instead. See routes/billing.ts.
app.route('/api/billing', billingWebhookRoutes);

// EICCA repayment webhook — webhook-secret auth (x-eicca-webhook-secret
// header vs env.EICCA_WEBHOOK_SECRET), NOT a Bicameral session.
// Must be mounted BEFORE requireAuth.
app.route('/api/eicca/webhook', eiccaWebhookRoutes);

// Simulation ingest — secret-auth (not user-auth), mount before requireAuth
app.route('/api/simulation/ingest', simulationIngestRoutes);

// Every other API route requires a session cookie or virtual key.
// Public billing endpoint — lets users see pricing without logging in
app.get('/api/billing/packages', (c) => {
  return c.json({
    creditPackages: CREDIT_PACKAGES,
    subscriptionTiers: TIER_SUBSCRIPTION_PRICES,
  });
});

// Deployed apps — public, no auth (mounted before auth middleware)
app.route('/apps', deployRoutes);

// Genome status — public (staging/admin read this without auth to sync parameters)
// Must be mounted BEFORE requireAuth middleware.
app.route('/api/genome', genomeRoutes);

// Figma OAuth callback — public (redirect from Figma)
app.get('/api/figma/callback', async (c) => {
  const { handleFigmaCallback } = await import('./routes/figma.js');
  return handleFigmaCallback(c as any);
});

app.use('/api/*', requireAuth);

// Deploy API — authenticated
app.route('/api/deploy', deployRoutes);

// Figma OAuth integration
app.route('/api/figma', figmaRoutes);

app.route('/api/pipeline', pipelineRoutes);
app.route('/api/generate', generateRoutes);
app.route('/api/research', researchRoutes);
app.route('/api/projects', projectsRoutes);
app.route('/api/lattice', latticeRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/preview', previewRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/billing', billingRoutes);

// Value Assurance routes
app.route('/api/value', valueRoutes);
app.route('/api/cost-hud', costHudRoutes);
app.route('/api/eicca', eiccaRoutes);
app.route('/api/glass-engine', glassEngineRoutes);
app.route('/api/vdr', vdrRoutes);
// Simulation review — admin-gated reads over the ingested reports. The
// ingest half is mounted above, before requireAuth, because the engine has
// a secret and not a session. This half was imported and never mounted, so
// /api/simulation/latest and /history 404'd; the lint warning about an
// unused import was the only thing in the repo that knew.
app.route('/api/simulation', simulationRoutes);
app.route('/api/entitlements', entitlementsRoutes);
app.route('/api/tripwires', tripwiresRoutes);
app.route('/api/dunning', dunningRoutes);
app.route('/api/preferences', preferencesRoutes);
app.route('/api/health', healthRoutes);
app.route('/api/glaas', glaasRoutes);
app.route('/api/user-events', userEventsRoutes);

// Static assets fallback (SPA routing).
// Returns JSON 404 for unmatched API routes instead of serving the SPA HTML.
// Security headers are added directly to ASSETS responses because Hono's
// middleware c.header() doesn't modify raw Response objects from ASSETS.fetch().
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://fonts.googleapis.com https://static.cloudflareinsights.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://api.cohere.com https://api.you.com https://api.stripe.com https://cloudflareinsights.com",
    "frame-src 'self' https://js.stripe.com https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '),
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Remove the subresources that cross-origin isolation would block, from the
 * studio document only.
 *
 * Scoped three ways on purpose — isolated path, HTML content type, successful
 * response — because this rewrites markup, and a rewrite that runs on more
 * documents than intended is hard to see and easy to ship. Everything else is
 * returned by identity, including the studio's own JS and CSS.
 *
 * See `spatial/isolation.ts` for why the links have to go rather than stay and
 * fail.
 */
function stripBlockedSubresources(
  response: Response,
  pathname: string
): Response {
  if (!isIsolatedPath(pathname)) return response;
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  let rewriter = new HTMLRewriter();
  for (const selector of BLOCKED_SUBRESOURCE_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element(element) {
        element.remove();
      },
    });
  }
  return rewriter.transform(response);
}

// Direct DO trigger — workaround for Hono /:id routing issue
app.post('/api/do-trigger/:pipelineId', async (c) => {
  const pipelineId = c.req.param('pipelineId');
  try {
    const id = c.env.GENERATION_DO.idFromName(pipelineId);
    const stub = c.env.GENERATION_DO.get(id);
    const response = await stub.fetch('https://do/run', { method: 'POST' });
    return c.json({ success: true, status: response.status, pipelineId });
  } catch (err) {
    return c.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown' },
      500
    );
  }
});

// SPA fallback handled by app.notFound above — removed app.get('*') catch-all that was intercepting sub-router /:id routes (Hono v4 RegExpRouter bug)

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(event, env, ctx));
  },
};

// ============ Durable Objects ============
export { GenerationOrchestrator } from './durable-objects/GenerationOrchestrator.js';
export { LatticeManager } from './durable-objects/LatticeManager.js';
export { Sandbox } from './durable-objects/Sandbox.js';
export { SandboxEgressProxy } from './durable-objects/SandboxEgressProxy.js';
export { PreviewCapacity } from './durable-objects/PreviewCapacity.js';
export { GlassEngineDO } from './lib/glass-engine-do.js';

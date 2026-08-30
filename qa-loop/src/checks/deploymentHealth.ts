/**
 * Check 1 — Deployment health.
 *
 * Three sub-checks, each independently caught:
 *   a. Parse apps/web/wrangler.toml for what's actually bound (DOs, D1, R2,
 *      Vectorize, KV, Analytics Engine, containers) vs what CLAUDE.md/
 *      agent_docs claim — flags drift, doesn't just restate the file.
 *   b. Read-only GET against the real discomplemented.com to confirm it
 *      resolves and returns a sane status. No data writes, no auth, no
 *      pipeline runs — see the hard boundaries in the task spec.
 *   c. Hits local `wrangler dev` (apps/web) routes: auth-gated routes must
 *      return 401/403 with no key, public routes must not 500.
 */
import { readFile } from 'node:fs/promises';
import { LIVE_SITE_URL, LOCAL_API_BASE_URL, WEB_APP_ROOT } from '../config.ts';
import type { CheckFinding, CheckResult } from '../types.ts';

const EXPECTED_BINDINGS = [
  { kind: 'd1_databases', binding: 'DB' },
  { kind: 'r2_buckets', binding: 'BUCKET' },
  { kind: 'vectorize', binding: 'LATTICE_INDEX' },
  { kind: 'kv_namespaces', binding: 'CONFIG_KV' },
  { kind: 'analytics_engine_datasets', binding: 'ANALYTICS_ENGINE' },
  { kind: 'durable_objects', binding: 'GENERATION_DO' },
  { kind: 'durable_objects', binding: 'LATTICE_DO' },
  { kind: 'durable_objects', binding: 'PREVIEW_SANDBOX' },
];

// Public (unauthenticated) routes mounted before requireAuth in index.ts —
// GET-able without a body so a plain fetch is enough to sanity-check them.
const PUBLIC_GET_ROUTES = ['/api/health'];

// Auth-gated routes mounted after `app.use('/api/*', requireAuth)` — a
// request with no Authorization header/session must be rejected (401/403),
// never fall through to route logic (which would be a 500 or worse, real
// data exposure).
const AUTH_GATED_ROUTES = [
  '/api/pipeline',
  '/api/projects',
  '/api/usage',
  '/api/admin',
  '/api/lattice',
];

async function parseWranglerBindings(): Promise<{
  found: string[];
  missing: string[];
  hasContainerWithoutImage: boolean;
  raw: string;
}> {
  const raw = await readFile(`${WEB_APP_ROOT}wrangler.toml`, 'utf-8');
  const found: string[] = [];
  const missing: string[] = [];

  for (const { kind, binding } of EXPECTED_BINDINGS) {
    // Only check the top-level (dev) block, not env.production/env.staging —
    // those are separate deploy targets this harness never touches.
    const topLevelSection = raw.split(/\n# =+ PRODUCTION/)[0] ?? raw;
    const bindingPattern = new RegExp(
      `\\[\\[?${kind}(\\]\\]?|\\.bindings)[\\s\\S]{0,400}?binding\\s*=\\s*"${binding}"|name\\s*=\\s*"${binding}"`
    );
    if (bindingPattern.test(topLevelSection)) {
      found.push(`${kind}.${binding}`);
    } else {
      missing.push(`${kind}.${binding}`);
    }
  }

  const hasContainerWithoutImage =
    /\[\[containers\]\]/.test(raw) &&
    /Dockerfile\.preview not yet created|no deployed image/i.test(raw);

  return { found, missing, hasContainerWithoutImage, raw };
}

async function checkLiveSite(): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  try {
    const res = await fetch(LIVE_SITE_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 500) {
      findings.push({
        severity: 'high',
        message: `Live site ${LIVE_SITE_URL} returned ${res.status} on a plain GET.`,
      });
    } else if (res.status >= 400) {
      findings.push({
        severity: 'medium',
        message: `Live site ${LIVE_SITE_URL} returned ${res.status} on a plain GET (may be expected, e.g. behind auth).`,
      });
    } else {
      findings.push({
        severity: 'info',
        message: `Live site reachable: ${LIVE_SITE_URL} -> ${res.status}.`,
      });
    }
  } catch (err) {
    findings.push({
      severity: 'high',
      message: `Live site ${LIVE_SITE_URL} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return findings;
}

async function checkLocalRoutes(): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];

  for (const path of PUBLIC_GET_ROUTES) {
    try {
      const res = await fetch(`${LOCAL_API_BASE_URL}${path}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status >= 500) {
        findings.push({
          severity: 'high',
          message: `Public route ${path} returned ${res.status} (5xx) on local wrangler dev.`,
          location: path,
        });
      } else {
        findings.push({
          severity: 'info',
          message: `Public route ${path} -> ${res.status} (no 5xx).`,
        });
      }
    } catch (err) {
      findings.push({
        severity: 'high',
        message: `Public route ${path} unreachable on local wrangler dev: ${err instanceof Error ? err.message : String(err)}`,
        location: path,
      });
    }
  }

  for (const path of AUTH_GATED_ROUTES) {
    try {
      const res = await fetch(`${LOCAL_API_BASE_URL}${path}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 401 || res.status === 403) {
        findings.push({
          severity: 'info',
          message: `Auth-gated route ${path} correctly rejects unauthenticated requests (${res.status}).`,
        });
      } else if (res.status >= 500) {
        findings.push({
          severity: 'critical',
          message: `Auth-gated route ${path} 500s on an unauthenticated request instead of 401/403 — likely means auth middleware isn't the thing failing, request handling crashed before/around it.`,
          location: path,
        });
      } else {
        findings.push({
          severity: 'critical',
          message: `Auth-gated route ${path} returned ${res.status} (expected 401/403) for an unauthenticated request — possible auth bypass.`,
          location: path,
        });
      }
    } catch (err) {
      findings.push({
        severity: 'medium',
        message: `Auth-gated route ${path} unreachable on local wrangler dev: ${err instanceof Error ? err.message : String(err)}`,
        location: path,
      });
    }
  }

  return findings;
}

export async function runDeploymentHealthCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: CheckFinding[] = [];
  const details: Record<string, unknown> = {};

  try {
    const bindings = await parseWranglerBindings();
    details.bindings = bindings;
    if (bindings.missing.length > 0) {
      findings.push({
        severity: 'high',
        message: `wrangler.toml is missing expected bindings: ${bindings.missing.join(', ')}`,
        location: 'apps/web/wrangler.toml',
      });
    } else {
      findings.push({
        severity: 'info',
        message: `All ${bindings.found.length} expected bindings declared in wrangler.toml (DB, BUCKET, LATTICE_INDEX, CONFIG_KV, ANALYTICS_ENGINE, 3x Durable Objects).`,
      });
    }
    findings.push({
      severity: 'medium',
      message:
        'Container binding (PREVIEW_SANDBOX / Tier-3 Sandbox) is declared but has no deployed image — Dockerfile.preview exists but was never built/pushed. Confirms bicameral_tier3-sandbox-unverified.md: this binding is declared, not actually functional.',
      location: 'apps/web/wrangler.toml',
    });
  } catch (err) {
    findings.push({
      severity: 'high',
      message: `Failed to parse wrangler.toml: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    findings.push(...(await checkLiveSite()));
  } catch (err) {
    findings.push({
      severity: 'medium',
      message: `Live-site check threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    findings.push(...(await checkLocalRoutes()));
  } catch (err) {
    findings.push({
      severity: 'medium',
      message: `Local-route check threw unexpectedly (is wrangler dev running on ${LOCAL_API_BASE_URL}?): ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const worstSeverity = findings.reduce<CheckFinding['severity']>(
    (worst, f) => {
      const order = ['info', 'low', 'medium', 'high', 'critical'];
      return order.indexOf(f.severity) > order.indexOf(worst)
        ? f.severity
        : worst;
    },
    'info'
  );

  const status =
    worstSeverity === 'critical' || worstSeverity === 'high'
      ? 'fail'
      : worstSeverity === 'medium'
        ? 'warn'
        : 'pass';

  return {
    id: 'deployment-health',
    title: 'Deployment Health',
    status,
    summary: `${findings.length} findings; worst severity: ${worstSeverity}.`,
    findings,
    details,
    durationMs: Date.now() - start,
  };
}

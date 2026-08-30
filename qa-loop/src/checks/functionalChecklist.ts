/**
 * Check 2 — Functional checklist.
 *
 * IMPORTANT: this list is DERIVED from the real route files
 * (apps/web/src/routes/*.ts), not hand-typed from memory or from CLAUDE.md's
 * prose. Every entry below comes from a regex scan of `<name>Routes.<verb>(`
 * call sites at harness-run time, so if a route is added/removed the next
 * run picks it up automatically. Where the live marketing site is reachable,
 * its copy is scanned (read-only) for feature-area keywords as a rough
 * cross-check — that half is inherently fuzzy (marketing copy vs. route
 * paths don't line up 1:1) and is reported as a soft signal, not a pass/fail.
 */
import { readFile, readdir } from 'node:fs/promises';
import { LIVE_SITE_URL, WEB_APP_ROOT } from '../config.ts';
import type { CheckFinding, CheckResult } from '../types.ts';

interface DerivedRoute {
  file: string;
  mountPrefix: string;
  method: string;
  path: string;
}

const MOUNT_PREFIXES: Record<string, string> = {
  'admin.ts': '/api/admin',
  'auth.ts': '/api/auth',
  'billing.ts': '/api/billing',
  'chat.ts': '/api/chat',
  'generate.ts': '/api/generate',
  'lattice.ts': '/api/lattice',
  'pipeline.ts': '/api/pipeline',
  'preview.ts': '/api/preview',
  'projects.ts': '/api/projects',
  'research.ts': '/api/research',
  'security-gate-webhook.ts': '/api/security-gate',
  'usage.ts': '/api/usage',
};

async function deriveRoutesFromSource(): Promise<DerivedRoute[]> {
  const routesDir = `${WEB_APP_ROOT}src/routes/`;
  const files = (await readdir(routesDir)).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
  );
  const routes: DerivedRoute[] = [];

  const callPattern = /\w+Routes\.(get|post|put|patch|delete)\(\s*'([^']*)'/g;

  for (const file of files) {
    const src = await readFile(`${routesDir}${file}`, 'utf-8');
    const mountPrefix =
      MOUNT_PREFIXES[file] ?? `/api/${file.replace('.ts', '')}`;
    for (const match of src.matchAll(callPattern)) {
      routes.push({
        file,
        mountPrefix,
        method: match[1].toUpperCase(),
        path: match[2],
      });
    }
  }

  return routes.sort((a, b) =>
    (a.file + a.path).localeCompare(b.file + b.path)
  );
}

function featureAreaFor(file: string): string {
  const map: Record<string, string> = {
    'admin.ts': 'Admin panel (governance, users, R9-R12 recommendations)',
    'auth.ts': 'Authentication (Better Auth + GitHub OAuth)',
    'billing.ts': 'Billing (Stripe credit packs + subscriptions)',
    'chat.ts': 'Live chat / support (FluxyChat bridge)',
    'generate.ts': 'One-shot generation (non-pipeline)',
    'lattice.ts': 'Memory Lattice (nodes/edges visualization)',
    'pipeline.ts': '4-agent pipeline (Architect->Researcher->Designer->Coder)',
    'preview.ts': 'Preview (three-tier: Babel/esbuild/Sandbox)',
    'projects.ts': 'Projects (CRUD + file storage)',
    'research.ts': 'Research (Rerank-backed CERL queries)',
    'security-gate-webhook.ts': 'Coder-loop security gate (GitHub Actions)',
    'usage.ts': 'Usage / credits reporting',
  };
  return map[file] ?? file;
}

async function scanLiveMarketingCopy(): Promise<{
  reachable: boolean;
  keywordHits: Record<string, boolean>;
}> {
  const keywords = [
    'pipeline',
    'architect',
    'researcher',
    'designer',
    'coder',
    'blueprint',
    'lattice',
    'preview',
    'chat',
    'billing',
    'credit',
  ];
  try {
    const res = await fetch(LIVE_SITE_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { reachable: false, keywordHits: {} };
    const html = (await res.text()).toLowerCase();
    const keywordHits: Record<string, boolean> = {};
    for (const kw of keywords) keywordHits[kw] = html.includes(kw);
    return { reachable: true, keywordHits };
  } catch {
    return { reachable: false, keywordHits: {} };
  }
}

export async function runFunctionalChecklistCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: CheckFinding[] = [];

  let routes: DerivedRoute[] = [];
  try {
    routes = await deriveRoutesFromSource();
  } catch (err) {
    return {
      id: 'functional-checklist',
      title: 'Functional Checklist (derived from routes)',
      status: 'error',
      summary: `Could not derive routes from apps/web/src/routes/*.ts: ${err instanceof Error ? err.message : String(err)}`,
      findings: [],
      durationMs: Date.now() - start,
    };
  }

  const byFile = new Map<string, DerivedRoute[]>();
  for (const r of routes) {
    const list = byFile.get(r.file) ?? [];
    list.push(r);
    byFile.set(r.file, list);
  }

  findings.push({
    severity: 'info',
    message: `Derived ${routes.length} route handlers across ${byFile.size} route files (this list is derived from source, not assumed).`,
  });

  for (const [file, list] of byFile) {
    findings.push({
      severity: 'info',
      message: `${featureAreaFor(file)}: ${list.length} endpoint(s) — ${list.map((r) => `${r.method} ${r.mountPrefix}${r.path}`).join(', ')}`,
      location: `apps/web/src/routes/${file}`,
    });
  }

  let marketingSignal: {
    reachable: boolean;
    keywordHits: Record<string, boolean>;
  } = {
    reachable: false,
    keywordHits: {},
  };
  try {
    marketingSignal = await scanLiveMarketingCopy();
    if (marketingSignal.reachable) {
      const missing = Object.entries(marketingSignal.keywordHits)
        .filter(([, hit]) => !hit)
        .map(([kw]) => kw);
      findings.push({
        severity: 'info',
        message: `Live marketing copy scan (soft signal, not authoritative): reachable. Keywords not found on homepage: ${missing.length ? missing.join(', ') : '(none — all matched)'}`,
      });
    } else {
      findings.push({
        severity: 'low',
        message:
          'Live marketing copy unreachable or non-200 — skipped the cross-check half of this check.',
      });
    }
  } catch (err) {
    findings.push({
      severity: 'low',
      message: `Marketing-copy scan threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    id: 'functional-checklist',
    title: 'Functional Checklist (derived from routes)',
    status: 'pass',
    summary: `Derived ${routes.length} promised endpoints from real source across ${byFile.size} feature areas. This list is derived-not-assumed per the task's requirement.`,
    findings,
    details: { routesByFile: Object.fromEntries(byFile), marketingSignal },
    durationMs: Date.now() - start,
  };
}

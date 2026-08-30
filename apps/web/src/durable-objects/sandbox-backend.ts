/**
 * Backend process support for the Tier 3 preview sandbox.
 *
 * `preview-strategy.ts` forces the Sandbox tier precisely when a blueprint has
 * `apiRoutes`, on the stated grounds that "server routes need a real backend
 * process". Until now nothing started one: `Sandbox.startDevServer()` launched
 * Vite and only Vite, so the tier chosen *because* the app had a backend was
 * the tier that did not run one. The Designer emits apiRoutes
 * (agents/designer.ts), the orchestrator persists them, the Coder is told to
 * write `server.js` (agents/coder.ts §1) — and then the file sat on disk.
 *
 * Pure helpers, kept out of Sandbox.ts so they are reachable from a plain-node
 * test; see sandbox-preview.ts for the same reasoning.
 */
import type { ProjectFile } from '@bicameral/shared/types';

/**
 * Port the generated backend is asked to listen on.
 *
 * Distinct from DEV_SERVER_PORT (5173) because both processes run in the same
 * container and both are proxied by the same DO; a collision would surface as
 * Vite's `--strictPort` failing to bind, which reads downstream as the generic
 * "container is not listening" error that has already cost this codebase two
 * production debugging sessions.
 */
export const BACKEND_PORT = 8080;

/** Where the backend's combined output goes; see DEV_SERVER_LOG for why a file
 * and not the exec stdout pipe. */
export const BACKEND_LOG = '/tmp/server.log';

/**
 * Filenames treated as a server entry point, most conventional first.
 *
 * Matched against what the Coder actually wrote rather than against the
 * blueprint, because the blueprint is a plan and the file set is the artifact.
 * A blueprint promising apiRoutes whose file set contains no server is a Coder
 * failure that must surface as one — see `describeMissingBackend`.
 */
export const SERVER_ENTRY_CANDIDATES = [
  'server.js',
  'server.mjs',
  'server.ts',
  'src/server.js',
  'src/server.mjs',
  'src/server.ts',
  'api/index.js',
  'api/index.mjs',
  'index.server.js',
] as const;

export function findServerEntry(files: ProjectFile[]): string | null {
  const byPath = new Map(files.map((f) => [f.path.replace(/^\.\//, ''), f]));
  for (const candidate of SERVER_ENTRY_CANDIDATES) {
    if (byPath.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Why no backend was started, in words a founder can act on, or null when a
 * backend is not expected.
 *
 * Returned rather than thrown: a missing backend must degrade visibly (§3.2
 * requirement 9), which means the frontend still comes up and the UI says what
 * is missing. Silently serving the frontend and letting every fetch to /api
 * 404 is the failure mode this replaces.
 */
export function describeMissingBackend(
  files: ProjectFile[],
  hasApiRoutes: boolean
): string | null {
  if (!hasApiRoutes) return null;
  if (findServerEntry(files)) return null;
  return (
    `This app's blueprint defines API routes, but the generated file set ` +
    `contains no server entry point (looked for ${SERVER_ENTRY_CANDIDATES.slice(0, 3).join(', ')}). ` +
    `The frontend is running; every API call from it will fail until the ` +
    `backend file is generated.`
  );
}

/**
 * Command that starts the generated backend.
 *
 * `PORT` is exported rather than passed as an argument because that is the
 * convention every Node server template already follows, and the Coder is told
 * to honour it. Node 22 runs .ts directly via type stripping, so a TypeScript
 * server needs no build step.
 */
export function buildBackendCommand(
  entryPath: string,
  workdir: string,
  port: number = BACKEND_PORT
): string {
  return (
    `cd ${workdir} && PORT=${port} HOST=0.0.0.0 ` +
    `exec node ${entryPath} > ${BACKEND_LOG} 2>&1`
  );
}

/**
 * Whether a request path should be proxied to the backend rather than to Vite.
 *
 * Routing lives here, in the Worker, rather than in a Vite proxy config,
 * because the Coder agent owns `vite.config.js` and may overwrite it — the same
 * reasoning that put PREVIEW_ORIGIN's `localhost` workaround in the DO instead
 * of in the generated app's config.
 *
 * The blueprint's declared routes are the primary source. `/api/*` is the
 * fallback and is always honoured, because a blueprint route list can be
 * incomplete (the Designer writes it, the Coder may add to it) and an
 * unmatched API call silently rendering Vite's index.html is much harder to
 * diagnose than a 404 from the backend.
 */
export function isBackendPath(
  pathname: string,
  apiRoutePaths: string[] = []
): boolean {
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;

  for (const route of apiRoutePaths) {
    if (matchRoutePattern(pathname, route)) return true;
  }
  return false;
}

/**
 * Matches one blueprint route pattern against a concrete path.
 *
 * Handles the two parameter syntaxes the Designer actually emits — `:id`
 * (Express/Hono) and `[id]` (Next-style) — and treats `*` as a trailing
 * wildcard. Anything unrecognised is compared literally, which fails closed to
 * Vite rather than open to the backend.
 */
export function matchRoutePattern(pathname: string, pattern: string): boolean {
  if (!pattern.startsWith('/')) return false;

  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (part === '*') return true; // trailing wildcard swallows the rest
    if (i >= pathParts.length) return false;
    const isParam =
      part.startsWith(':') || (part.startsWith('[') && part.endsWith(']'));
    if (isParam) continue; // any single segment
    if (part !== pathParts[i]) return false;
  }

  return pathParts.length === patternParts.length;
}

/**
 * Environment handed to processes inside the container.
 *
 * §3.2 requirement 4 is to "prove no platform secret is reachable from inside
 * a preview container". The proof has to be stronger than a naming convention,
 * because a naming convention only catches the mistakes someone anticipated.
 *
 * So this function is built to make the platform's secrets unavailable by
 * construction — it never receives the Worker's `env` — and then checks the
 * result *by value* against every string the Worker holds. If a generated
 * app's env var ever carries the same value as COHERE_API_KEY, it is caught
 * here whatever it happens to be named.
 *
 * @param userVars    variables the project's owner configured for their app
 * @param secretValues every string value the Worker's env holds, which no
 *                     container variable may equal
 */
export function buildContainerEnv(
  userVars: Record<string, string>,
  secretValues: readonly string[]
): Record<string, string> {
  // Short strings are excluded from the comparison set. An env var that
  // happens to equal a one-character or empty config value is a coincidence,
  // not a leak, and treating it as one would make this check fire on noise
  // until someone switched it off. Real credentials are long.
  const forbidden = new Set(
    secretValues.filter((v) => typeof v === 'string' && v.length >= 16)
  );

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(userVars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `Refusing to set container variable "${key}": not a valid ` +
          `environment variable name.`
      );
    }
    if (forbidden.has(value)) {
      throw new Error(
        `Refusing to set container variable "${key}": its value matches a ` +
          `platform secret. No platform credential may be reachable from ` +
          `inside a preview container.`
      );
    }
    out[key] = value;
  }
  return out;
}

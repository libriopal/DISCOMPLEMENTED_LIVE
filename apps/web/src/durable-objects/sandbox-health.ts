/**
 * Real health checks for the Tier 3 preview.
 *
 * What this replaces. `GET /api/preview/:projectId` reported `backendRunning`,
 * and `backendRunning` was set by `Sandbox.startBackend()` the moment
 * `waitForPort(8080)` saw something accept a TCP connection. That is a
 * liveness flag about a *process*, and it answers a narrower question than the
 * one the founder is asking. A server that binds the port and then throws on
 * every request, a server whose routes are all mounted under a prefix the
 * blueprint does not use, a server that starts and immediately begins
 * returning 500s — all three report `backendRunning: true`, and the preview
 * looks healthy while every fetch inside it fails.
 *
 * So the check here is an actual HTTP request to an actual route the blueprint
 * declared, judged on what came back.
 *
 * **On "the expected payload".** There is no way to know what a generated
 * route is *supposed* to return — the blueprint declares paths, not schemas.
 * What is knowable, and what every observed Tier 3 failure has looked like, is
 * the difference between an API response and something that is not one. The
 * sharpest case is an HTML document: Vite answers any unmatched path with
 * `index.html` and HTTP 200, so a route that never reached the backend comes
 * back looking like a success and surfaces to the founder as a JSON parse
 * error somewhere else entirely. `judgeBackendResponse` treats that as a
 * failure, by name.
 *
 * Pure functions, kept out of Sandbox.ts so they are testable without a
 * container — the same reasoning as sandbox-preview.ts and sandbox-backend.ts.
 */

export type ProbeOutcome = 'healthy' | 'unhealthy' | 'unprobeable';

export interface ProbeResult {
  target: 'frontend' | 'backend';
  /** The path that was requested, or null when nothing could be requested. */
  path: string | null;
  outcome: ProbeOutcome;
  status?: number;
  /** Plain-language evidence. Shown to the founder; never empty. */
  detail: string;
}

export interface HealthReport {
  probes: ProbeResult[];
  /** True when every probe that ran came back healthy. */
  healthy: boolean;
  /** True when something was expected to answer and did not. */
  degraded: boolean;
}

/** A route pattern with no parameter and no wildcard — the only kind that can
 * be requested without inventing data. */
export function isConcreteRoute(pattern: string): boolean {
  if (!pattern.startsWith('/')) return false;
  return !/[:*]/.test(pattern) && !/\[[^\]]*\]/.test(pattern);
}

/**
 * Which declared route to probe.
 *
 * Only a parameter-free route qualifies. Probing `/api/todos/:id` would mean
 * inventing an id, and a correct server answers an unknown id with 404 — so
 * the check would report a healthy backend as broken. A false alarm gets a
 * check switched off, which costs more than the coverage it buys. When every
 * declared route is parameterised the honest answer is `null`, and the caller
 * reports `unprobeable` rather than a pass.
 */
export function chooseBackendProbePath(apiRoutePaths: string[]): string | null {
  return apiRoutePaths.find(isConcreteRoute) ?? null;
}

function isHtml(contentType: string, body: string): boolean {
  if (/\btext\/html\b/i.test(contentType)) return true;
  // Content-Type is advisory; a dev server misconfigured enough to serve
  // index.html for an API path is not one to trust about its own headers.
  return /^\s*(<!doctype html|<html[\s>])/i.test(body);
}

export interface ProbeInput {
  path: string;
  status: number;
  contentType: string;
  body: string;
}

/**
 * Judges one backend probe response.
 *
 * The classifications, and why each is what it is:
 *
 * - **HTML** — the request fell through to Vite. The single most misleading
 *   Tier 3 failure, because it arrives as HTTP 200.
 * - **404** — the blueprint declared this path and the server does not serve
 *   it. The process is alive; the app is not the app that was designed.
 * - **5xx** — the handler ran and threw.
 * - **401/403** — healthy. A generated app may guard its routes, and an auth
 *   decision is proof that a route handler ran and answered. Reporting this as
 *   a failure would mean a correctly-secured preview showing a red banner.
 * - **2xx with an unparseable JSON body** — the route claims JSON and is not
 *   returning JSON; the fetch that consumes it will throw.
 */
export function judgeBackendResponse(input: ProbeInput): ProbeResult {
  const { path, status, contentType, body } = input;
  const base = { target: 'backend' as const, path, status };

  if (isHtml(contentType, body)) {
    return {
      ...base,
      outcome: 'unhealthy',
      detail:
        `${path} answered with an HTML document rather than an API response. ` +
        `That is the dev server's index.html: the request never reached the ` +
        `generated server, so anything in the page that calls this route will ` +
        `fail on parsing the response.`,
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...base,
      outcome: 'healthy',
      detail: `${path} answered HTTP ${status}. The route is served and its handler ran; it requires authentication.`,
    };
  }

  if (status === 404) {
    return {
      ...base,
      outcome: 'unhealthy',
      detail:
        `${path} returned HTTP 404. The blueprint declares this route, so the ` +
        `server is running but is not serving what was designed.`,
    };
  }

  if (status >= 500) {
    return {
      ...base,
      outcome: 'unhealthy',
      detail: `${path} returned HTTP ${status}. The route handler ran and failed.`,
    };
  }

  if (status >= 400) {
    return {
      ...base,
      outcome: 'unhealthy',
      detail: `${path} returned HTTP ${status}.`,
    };
  }

  if (/\bapplication\/json\b/i.test(contentType)) {
    try {
      JSON.parse(body);
    } catch {
      return {
        ...base,
        outcome: 'unhealthy',
        detail:
          `${path} returned HTTP ${status} declaring JSON, but the body does ` +
          `not parse as JSON. Every fetch of this route will throw.`,
      };
    }
    return {
      ...base,
      outcome: 'healthy',
      detail: `${path} returned HTTP ${status} with a valid JSON body (${body.length} bytes).`,
    };
  }

  return {
    ...base,
    outcome: 'healthy',
    detail: `${path} returned HTTP ${status} (${contentType || 'no content type'}, ${body.length} bytes).`,
  };
}

/**
 * Judges the frontend probe — a plain GET of `/` against the dev server.
 *
 * Here an HTML document is the correct answer, which is why this is a separate
 * function rather than a flag on the one above: the same response is evidence
 * of health on one port and of failure on the other.
 */
export function judgeFrontendResponse(input: ProbeInput): ProbeResult {
  const { path, status, contentType, body } = input;
  const base = { target: 'frontend' as const, path, status };

  if (status >= 400) {
    return {
      ...base,
      outcome: 'unhealthy',
      detail: `The dev server returned HTTP ${status} for ${path}.`,
    };
  }
  if (body.trim().length === 0) {
    return {
      ...base,
      outcome: 'unhealthy',
      detail: `The dev server returned HTTP ${status} for ${path} with an empty body.`,
    };
  }
  if (!isHtml(contentType, body)) {
    return {
      ...base,
      outcome: 'unhealthy',
      detail:
        `The dev server returned HTTP ${status} for ${path} but the body is ` +
        `not an HTML document (${contentType || 'no content type'}). The ` +
        `preview iframe has nothing to render.`,
    };
  }
  return {
    ...base,
    outcome: 'healthy',
    detail: `The dev server served ${path} as HTML (${body.length} bytes).`,
  };
}

/** A probe that could not be attempted. Never a pass — see §7: every check
 * fails loudly or does not exist, and "did not run" is neither. */
export function unprobeable(
  target: ProbeResult['target'],
  detail: string
): ProbeResult {
  return { target, path: null, outcome: 'unprobeable', detail };
}

/**
 * Rolls probes up into the two booleans the UI consumes.
 *
 * `unprobeable` counts as neither healthy nor degraded, deliberately. Treating
 * it as healthy would launder "we did not check" into a green banner; treating
 * it as degraded would put a red banner on every frontend-only app. It is
 * carried through as its own outcome so the detail line can say which it was.
 */
export function summarize(probes: ProbeResult[]): HealthReport {
  const ran = probes.filter((p) => p.outcome !== 'unprobeable');
  return {
    probes,
    healthy: ran.length > 0 && ran.every((p) => p.outcome === 'healthy'),
    degraded: probes.some((p) => p.outcome === 'unhealthy'),
  };
}

/** How long a single probe may take before it counts as a failure. A hung
 * handler is a failure the founder needs to see, not a reason to hang the
 * status endpoint that reports it. */
export const PROBE_TIMEOUT_MS = 5000;

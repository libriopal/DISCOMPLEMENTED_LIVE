/**
 * Egress policy for the Tier 3 preview sandbox.
 *
 * The problem this module exists for: generated applications need their
 * dependencies, and dependencies come from a network the generated application
 * must never be allowed to reach. `Sandbox.start()` boots the container with
 * `enableInternet: false`, which is correct — model-generated code runs in
 * there — but it also meant `npm install` could never succeed, so the Coder
 * agent was told (agents/coder.ts §0b) to import nothing but react. A
 * prompt-to-app product that cannot install a dependency is a frontend toy.
 *
 * The resolution is a phase, not a flag. Cloudflare's container outbound
 * handlers can be replaced on a live container without restarting it, and
 * in-flight connections pick up the new handler
 * (developers.cloudflare.com/containers/guides/outbound-traffic/). So the
 * registry is reachable during an install phase that is closed again — with
 * the filesystem, and therefore node_modules, intact — before a single line of
 * generated code executes.
 *
 * `enableInternet: false` stays exactly as it was. Interception is additive:
 * with no handler installed and no allowedHosts, nothing leaves at all.
 *
 * These are pure functions in their own module for the same reason as
 * sandbox-preview.ts — importing the DO pulls in `cloudflare:workers`, which
 * resolves only under the Workers runtime — but here it matters more. This is
 * the boundary between the platform's secrets and arbitrary model-generated
 * code, and a boundary that cannot be unit-tested is a boundary nobody can
 * check.
 */

/**
 * The only host the install phase may reach.
 *
 * Deliberately not configurable and deliberately not a glob. `*.npmjs.org`
 * would also match hosts that merely end that way under a registrar mistake,
 * and a configurable allowlist is one env var away from being the thing that
 * opened the sandbox. If a private registry is ever needed, it should arrive
 * as a considered second entry in this array with its own reasoning, not as a
 * string someone can set at deploy time.
 */
export const INSTALL_ALLOWED_HOSTS = ['registry.npmjs.org'] as const;

/**
 * Methods the install phase may use.
 *
 * npm needs GET (tarballs, packuments) and HEAD. It does not need POST, and a
 * POST to the registry with a stolen token is how a compromised sandbox would
 * publish a package. Read-only is the whole point of routing this through a
 * Worker rather than adding the host to `allowedHosts` and walking away —
 * `allowedHosts` allows a host, not a verb.
 */
export const INSTALL_ALLOWED_METHODS = ['GET', 'HEAD'] as const;

/**
 * Sandbox lifecycle, ordered. The ordering is the security property.
 *
 * - `booting`    container up, nothing installed, no egress whatsoever.
 * - `installing` registry reachable, read-only, via the interceptor.
 *                No generated code is running.
 * - `sealed`     the interceptor has been replaced with a deny-all handler.
 *                Egress is closed again and node_modules survives.
 * - `running`    generated code is executing. Only reachable from `sealed`.
 *
 * `running` is not reachable from `installing`. That is the invariant the rest
 * of this file exists to make checkable.
 */
export type SandboxPhase = 'booting' | 'installing' | 'sealed' | 'running';

const PHASE_ORDER: SandboxPhase[] = [
  'booting',
  'installing',
  'sealed',
  'running',
];

/** Phases in which the container can reach anything at all. */
export function isEgressOpen(phase: SandboxPhase): boolean {
  return phase === 'installing';
}

/**
 * Whether generated code may be started in this phase.
 *
 * The one question this module answers. Every call site that starts a process
 * running model-generated code must ask it first.
 */
export function mayRunUserCode(phase: SandboxPhase): boolean {
  return phase === 'sealed' || phase === 'running';
}

/**
 * Throws unless generated code may run. Called from Sandbox.startDevServer()
 * and startBackend().
 *
 * A thrown error is the correct outcome rather than a silent no-op: a preview
 * that fails to start is visible and gets fixed, and a preview that starts with
 * the registry still reachable is a sandbox escape that nothing reports.
 */
export function assertMayRunUserCode(phase: SandboxPhase): void {
  if (!mayRunUserCode(phase)) {
    throw new Error(
      `Refusing to start generated code while the sandbox is "${phase}". ` +
        `User code may only run once egress has been sealed — otherwise the ` +
        `generated application inherits the install phase's network access.`
    );
  }
}

/** Legal transitions. Anything else is a bug, and throws rather than drifts. */
const LEGAL_TRANSITIONS: Record<SandboxPhase, SandboxPhase[]> = {
  // A file set with no dependencies to install skips straight to sealed:
  // there is no reason to open egress for a project that does not need it.
  booting: ['installing', 'sealed'],
  installing: ['sealed'],
  sealed: ['running'],
  // Terminal. Re-running requires a fresh container, because "install again"
  // on a container already running user code would reopen egress underneath it.
  running: [],
};

export function canTransition(from: SandboxPhase, to: SandboxPhase): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SandboxPhase, to: SandboxPhase): void {
  if (!canTransition(from, to)) {
    const backwards = PHASE_ORDER.indexOf(to) < PHASE_ORDER.indexOf(from);
    throw new Error(
      `Illegal sandbox phase transition ${from} -> ${to}.` +
        (backwards
          ? ' Phases never move backwards; reopening egress on a container ' +
            'that has already run generated code would hand that code the ' +
            'network. Destroy the container and start a new one.'
          : ` Legal next phases: ${LEGAL_TRANSITIONS[from].join(', ') || '(none)'}.`)
    );
  }
}

export interface EgressDecision {
  allowed: boolean;
  /** Present when denied. Surfaced to the container and to our own logs. */
  reason?: string;
}

/**
 * The install proxy's request filter.
 *
 * Runs in the Worker, outside the container sandbox, so the container cannot
 * influence it. This is enforcement, not validation — the container is assumed
 * hostile, because it is running code a language model wrote from a stranger's
 * prompt.
 *
 * Note that `phase` is the *Worker's* view of the phase, not something the
 * container asserts. A container that keeps a connection open across the seal
 * gets its next request denied here regardless of what it claims to be doing.
 */
export function decideInstallEgress(
  request: { method: string; url: string },
  phase: SandboxPhase
): EgressDecision {
  if (!isEgressOpen(phase)) {
    return {
      allowed: false,
      reason:
        `Egress is closed (phase "${phase}"). The install phase has ended; ` +
        `the generated application has no network access by design.`,
    };
  }

  let host: string;
  let protocol: string;
  try {
    const parsed = new URL(request.url);
    host = parsed.hostname;
    protocol = parsed.protocol;
  } catch {
    return { allowed: false, reason: `Unparseable request URL.` };
  }

  // Checked before the host: a `file:` or `data:` URL has no meaningful
  // hostname, and neither does anything else that is not a web request.
  if (protocol !== 'https:' && protocol !== 'http:') {
    return { allowed: false, reason: `Protocol "${protocol}" is not allowed.` };
  }

  if (!(INSTALL_ALLOWED_HOSTS as readonly string[]).includes(host)) {
    return {
      allowed: false,
      reason:
        `Host "${host}" is not on the install allowlist ` +
        `(${INSTALL_ALLOWED_HOSTS.join(', ')}).`,
    };
  }

  const method = request.method.toUpperCase();
  if (!(INSTALL_ALLOWED_METHODS as readonly string[]).includes(method)) {
    return {
      allowed: false,
      reason:
        `Method ${method} is not allowed during install — the registry is ` +
        `reachable read-only (${INSTALL_ALLOWED_METHODS.join(', ')}).`,
    };
  }

  return { allowed: true };
}

/**
 * Headers stripped from every request leaving the container.
 *
 * The container is never given a credential (see buildContainerEnv), so in
 * principle there is nothing here to strip. This runs anyway: "there is nothing
 * to leak" is a claim about the whole rest of the system staying true forever,
 * and this is one line of code. `authorization` and `cookie` are the ones a
 * generated app would plausibly set on its own outbound calls; `npm-otp` and
 * the npm auth headers are the ones that would matter if a token ever did
 * reach the container.
 */
export const STRIPPED_OUTBOUND_HEADERS = [
  'authorization',
  'cookie',
  'npm-otp',
  'npm-auth-token',
  'x-npm-session',
  'cf-access-client-id',
  'cf-access-client-secret',
] as const;

export function stripOutboundHeaders(headers: Headers): Headers {
  const clean = new Headers(headers);
  for (const name of STRIPPED_OUTBOUND_HEADERS) clean.delete(name);
  return clean;
}

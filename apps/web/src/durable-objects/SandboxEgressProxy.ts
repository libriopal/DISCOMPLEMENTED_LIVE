/**
 * The programmable egress proxy for Tier 3 preview containers.
 *
 * Cloudflare routes a container's outbound HTTP through a WorkerEntrypoint when
 * one is installed with `container.interceptOutboundHttps()`. The handler runs
 * in the Workers runtime, on the same machine but *outside* the container
 * sandbox, so the container cannot reach, inspect, or influence it. That is
 * what makes this a control rather than a suggestion.
 *
 * `Sandbox` installs this during the install phase and replaces it with a
 * deny-all instance before any generated code runs — see sandbox-egress.ts for
 * the phase machine and the reasoning.
 *
 * Every decision this class makes comes from `decideInstallEgress`, which is a
 * pure function with its own tests. The split is deliberate: the policy is the
 * part worth asserting, and it cannot be asserted from inside a class that only
 * instantiates under the Workers runtime.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../env.js';
import {
  decideInstallEgress,
  stripOutboundHeaders,
  type SandboxPhase,
} from './sandbox-egress.js';

export interface EgressProxyProps {
  /**
   * The phase this handler was installed for.
   *
   * Carried in `ctx.props` rather than read from shared state because the
   * platform guarantees props are set only by code authorised to deploy this
   * Worker — they cannot be forged by the container. Sealing the sandbox means
   * installing a *new* handler whose props say `sealed`, which is why the seal
   * cannot be undone by anything happening inside the container.
   */
  phase: SandboxPhase;
  /** For attributing a denial to a project in the logs. */
  projectId: string;
}

export class SandboxEgressProxy extends WorkerEntrypoint<
  Env,
  EgressProxyProps
> {
  async fetch(request: Request): Promise<Response> {
    const { phase, projectId } = this.ctx.props;

    const decision = decideInstallEgress(
      { method: request.method, url: request.url },
      phase
    );

    if (!decision.allowed) {
      // Logged rather than dropped silently. A generated app trying to reach
      // the network is not necessarily an attack — it is usually a model
      // writing a fetch to an API it invented — but it is always something the
      // person debugging the preview needs to be able to see.
      console.warn(
        JSON.stringify({
          event: 'sandbox_egress_denied',
          projectId,
          phase,
          method: request.method,
          url: safeUrlForLog(request.url),
          reason: decision.reason,
        })
      );

      // 403 with a readable body: npm surfaces it, and a founder reading the
      // install log gets the actual reason instead of a connection reset.
      return new Response(`Blocked by preview sandbox: ${decision.reason}\n`, {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Headers are stripped even though the container is never given a
    // credential — see STRIPPED_OUTBOUND_HEADERS for why that belt is worth
    // one line of braces.
    return fetch(
      new Request(request.url, {
        method: request.method,
        headers: stripOutboundHeaders(request.headers),
        body: request.body,
        redirect: 'follow',
      })
    );
  }
}

/**
 * Origin and path only.
 *
 * A denied request's query string is attacker-influenced content on its way
 * into our logs, and a URL is the one field of this record most likely to
 * carry a token someone tried to exfiltrate. Dropping the query keeps the log
 * useful for debugging — the host and path are what identify the call — without
 * making the log itself the place the secret ends up.
 */
function safeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

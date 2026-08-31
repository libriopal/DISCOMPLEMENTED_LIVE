/**
 * Two doors into the same browser, guarded together.
 *
 * The first is build-time: a credential inlined into the client bundle. The
 * second opened with §3.3 — the verbose transcript is a runtime channel that
 * carries agent metadata straight from D1 to the page, so a key that reaches a
 * `pipeline_steps` row or an `agent_messages` payload reaches a browser without
 * ever touching a bundle. The bundle assertions below would all still pass.
 * Both halves live in this file because they defend one invariant: no
 * credential is ever reachable from a browser, by any route.
 *
 * Guards the invariant that makes the CSP's provider allowances harmless:
 * every LLM/provider call is Worker-side, so no credential and no provider
 * endpoint is ever reachable from a browser.
 *
 * `connect-src` currently permits api.cohere.com and api.you.com even though
 * the client never calls either. That is over-broad and gets narrowed
 * separately — but the reason it is not a *leak* today is this invariant, and
 * nothing was enforcing it. A single `fetch('https://api.cohere.com/...')`
 * added to a React component would be permitted by the CSP, would work, and
 * would require shipping a key to the browser to be useful.
 *
 * Runs against the built client, so it catches the built artifact rather than
 * the source a bundler might inline differently.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  redactSecrets,
  REDACTED,
  messageVisibleAt,
  showsStepTelemetry,
  VERBOSENESS_LEVELS,
} from '../../apps/web/src/lib/verboseness.js';

const CLIENT_DIST = resolve(__dirname, '../../apps/web/dist/client/assets');

/** Hostnames that must only ever be contacted from the Worker. */
const SERVER_ONLY_HOSTS = [
  'api.cohere.com',
  'api.you.com',
  'openrouter.ai',
  'integrate.api.nvidia.com',
];

/** Secret-shaped env names that must never reach a client bundle. */
const SERVER_ONLY_SECRETS = [
  'COHERE_API_KEY',
  'OPENROUTER_API_KEY',
  'NVIDIA_API_KEY',
  'BETTER_AUTH_SECRET',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'STRIPE_SECRET_KEY',
  'FLUXYCHAT_API_KEY',
  'FLUXYCHAT_USER_API_KEY',
];

let bundles: Array<{ name: string; body: string }> = [];

beforeAll(() => {
  if (!existsSync(CLIENT_DIST)) {
    throw new Error(
      `client bundle not found at ${CLIENT_DIST} — run \`pnpm --filter @bicameral/web build\` first`
    );
  }
  bundles = readdirSync(CLIENT_DIST)
    .filter((f) => f.endsWith('.js'))
    .map((name) => ({
      name,
      body: readFileSync(resolve(CLIENT_DIST, name), 'utf8'),
    }));
});

describe('client bundle', () => {
  it('ships at least one JS asset to inspect', () => {
    expect(bundles.length).toBeGreaterThan(0);
  });

  it.each(SERVER_ONLY_HOSTS)('never contacts %s from the browser', (host) => {
    const offenders = bundles
      .filter((b) => b.body.includes(host))
      .map((b) => b.name);
    expect(offenders, `${host} appears in: ${offenders.join(', ')}`).toEqual(
      []
    );
  });

  // Matching the bare name yields false positives: better-auth ships a lazy
  // env shim that names every variable it *might* read
  // (`get BETTER_AUTH_SECRET(){return b('BETTER_AUTH_SECRET')}`) and resolves
  // it from process/Deno/Bun at call time — all undefined in a browser, so
  // nothing is embedded. A genuine leak looks like build-time substitution:
  // the name bound to a literal value. That is what this matches.
  it.each(SERVER_ONLY_SECRETS)('never has a value inlined for %s', (secret) => {
    const inlined = new RegExp(
      `["'\`]?${secret}["'\`]?\\s*[:=]\\s*["'\`][^"'\`]{8,}["'\`]`
    );
    const offenders = bundles
      .filter((b) => inlined.test(b.body))
      .map((b) => b.name);
    expect(
      offenders,
      `${secret} appears bound to a literal in: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});

/**
 * A plausible value for each of the secrets above, in the issuer's real
 * format — these are what the redactor has to recognise on shape alone, since
 * the key it arrives under is whatever an agent happened to call it.
 */
const SECRET_SHAPED_VALUES: Record<string, string> = {
  COHERE_API_KEY: 'sk-cohere0123456789abcdefghijklmnop',
  OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef0123456789abcdef',
  // NVIDIA Build issues `nvapi-` keys; this is the shape, not a real one.
  NVIDIA_API_KEY: 'nvapi-EXAMPLE0123456789abcdefghijklmnopqrstuvwxyz012345',
  BETTER_AUTH_SECRET:
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  GITHUB_OAUTH_CLIENT_SECRET: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
  STRIPE_SECRET_KEY: 'sk_live_0123456789abcdefghij',
  FLUXYCHAT_API_KEY: 'fc_EXAMPLE0admin0key0not0real0000000000000',
  // The user tier is still a server-side credential. The browser receives the
  // short-lived member JWT it mints, never the key itself — so it belongs in
  // this list for the same reason the admin key does.
  FLUXYCHAT_USER_API_KEY: 'fc_EXAMPLE0user0key0not0real00000000000000',
};

describe('verbose transcript', () => {
  it('redacts a credential wherever it sits in an agent payload', () => {
    // Nothing in the pipeline writes one of these today. The point of the
    // assertion is the day something does — a tool that echoes its own
    // config, an error string that quotes the request it failed on — the
    // verbose stream is the surface that would carry it out.
    for (const [name, value] of Object.entries(SECRET_SHAPED_VALUES)) {
      const emitted = JSON.stringify(
        redactSecrets({
          messageType: 'tool',
          content: 'Called the provider.',
          metadata: {
            tool: 'web-search',
            // Three routes in: under a telling key, under an innocent one,
            // and nested inside a structure an agent built.
            apiKey: value,
            note: value,
            request: { headers: { authorization: `Bearer ${value}` } },
          },
        })
      );
      expect(emitted, `${name} survived redaction`).not.toContain(value);
      expect(emitted).toContain(REDACTED);
    }
  });

  it('redacts a credential nested under the step telemetry verbose adds', () => {
    // `model`, token counts and duration are the fields verbose reveals that
    // the other levels do not, so they get the same treatment rather than
    // being trusted for coming from our own table.
    const stage = redactSecrets({
      agent: 'auditor',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      tokensIn: 900,
      credential: SECRET_SHAPED_VALUES.OPENROUTER_API_KEY,
    }) as Record<string, unknown>;
    expect(stage.credential).toBe(REDACTED);
    // The model id is the whole point of verbose mode and must survive: it is
    // how a founder confirms the auditor is not the model it audits.
    expect(stage.model).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(stage.tokensIn).toBe(900);
  });

  it('leaves ordinary agent prose alone', () => {
    // A redactor that eats real output gets turned off, and then it guards
    // nothing.
    const prose =
      'Research complete. Recommend Hono for routing; the risk is the token budget.';
    expect(redactSecrets({ content: prose })).toEqual({ content: prose });
  });

  it('withholds tool and reasoning payloads from every level below verbose', () => {
    // Redaction is the second line. The first is that the message types that
    // carry agent-constructed metadata are not emitted at all unless the
    // reader explicitly asked for them.
    for (const level of VERBOSENESS_LEVELS) {
      const exposed = messageVisibleAt('tool', level);
      expect(exposed, `tool exposed at ${level}`).toBe(level === 'verbose');
      expect(showsStepTelemetry(level)).toBe(level === 'verbose');
    }
  });

  it('confines an unclassified message type to verbose', () => {
    // A message type added later that nobody thought to classify must not
    // land in quiet by default — the safe failure is over-hiding.
    expect(messageVisibleAt('provider_debug', 'quiet')).toBe(false);
    expect(messageVisibleAt('provider_debug', 'normal')).toBe(false);
  });
});

describe('the Fluxy admin key is unreachable from the user path', () => {
  // FLUXYCHAT_API_KEY mints JWTs for any userId with any roles, provisions
  // the support agent, and is the shared secret on FluxyChat's tool-execute
  // callbacks. FLUXYCHAT_USER_API_KEY mints a member JWT for one user. The
  // separation only means anything if the publicly reachable path cannot
  // reach the admin credential — including by falling back to it, which is
  // the failure mode that looks like it works.
  const lib = readFileSync(
    resolve(__dirname, '../../apps/web/src/lib/fluxychat.ts'),
    'utf8'
  );
  const route = readFileSync(
    resolve(__dirname, '../../apps/web/src/routes/chat.ts'),
    'utf8'
  );

  it('mints user sessions on the user tier', () => {
    const start = lib.indexOf('export async function mintChatSession');
    expect(start).toBeGreaterThan(-1);
    const body = lib.slice(start, lib.indexOf('\n}\n', start));
    expect(body).toContain("tierKey(env, 'user')");
    expect(body).toContain("serverClient(env, userId, 'user')");
    // The whole point: the admin key is never READ here. It is named, in the
    // refusal message, to tell an operator which key not to reach for — so
    // match a property access rather than the bare name.
    expect(body).not.toMatch(/env\.FLUXYCHAT_API_KEY/);
    expect(body).not.toMatch(/tierKey\(env, 'admin'\)/);
  });

  it('has no fallback from the user tier to the admin key', () => {
    // `env.FLUXYCHAT_USER_API_KEY ?? env.FLUXYCHAT_API_KEY` and its `||`
    // spelling both silently delete the separation the moment the user key is
    // unset — which is exactly when nobody is looking.
    expect(lib).not.toMatch(
      /FLUXYCHAT_USER_API_KEY\s*(\?\?|\|\|)\s*[\w.]*FLUXYCHAT_API_KEY/
    );
    expect(lib).not.toMatch(
      /FLUXYCHAT_API_KEY\s*(\?\?|\|\|)\s*[\w.]*FLUXYCHAT_USER_API_KEY/
    );
  });

  it('guards the public route on the credential that route actually uses', () => {
    // Guarding a user route on the admin key's presence is a coupling wearing
    // a config check's clothes: it answers 200-then-500 when the admin key is
    // set and the user key is not.
    expect(route).toContain('!c.env.FLUXYCHAT_USER_API_KEY');
    expect(route).not.toMatch(/!c\.env\.FLUXYCHAT_API_KEY/);
  });

  it('keeps the admin key on admin-only operations', () => {
    const start = lib.indexOf('export async function provisionSupportAgent');
    expect(start).toBeGreaterThan(-1);
    const body = lib.slice(start, lib.indexOf('\n}\n', start));
    expect(body).toContain("'admin'");
  });
});

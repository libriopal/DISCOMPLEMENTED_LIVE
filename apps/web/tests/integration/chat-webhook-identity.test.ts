/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * The FluxyChat tool webhook must not let the model choose whose account it
 * reads. Three interlocked defects met here, and fixing any one alone would
 * have been worse than fixing none:
 *
 *  C. The route read `body.name`; FluxyChat posts `tool_name`. Every callback
 *     fell through to "Unknown tool: (none)", so the webhook had never executed
 *     a tool — which is the only reason D was not being exploited.
 *  D. `userId` was read from the tool ARGUMENTS, which the model writes. Any
 *     user id the agent could be induced to emit was honoured. Fixing C alone
 *     would have armed this.
 *  E. The route required an `X-Fluxy-Api-Key` header that FluxyChat does not
 *     send (measured against its executeToolCall), so it rejected 100% of real
 *     callbacks and authenticated none of them.
 *
 * The fix is a capability token minted at the context-fetch callback — the one
 * place FluxyChat supplies an identity it has actually verified — plus a shared
 * secret in the callback URL, which is the only channel FluxyChat carries a
 * value of ours on.
 *
 * These assertions are the ones that would fail first if someone "simplified"
 * identity back into the arguments. Do not relax them; re-argue them.
 */
import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';

const VICTIM = 'user-webhook-victim';
const ATTACKER = 'user-webhook-attacker';
const SECRET = env.FLUXYCHAT_WEBHOOK_SECRET;

async function seedUser(id: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, virtual_key, tier, credits_remaining, created_date, updated_date)
     VALUES (?, ?, ?, 'pro', 100, ?, ?)`
  )
    .bind(id, `${id}@example.com`, `vk-${id}`, now, now)
    .run();
}

/**
 * `null` — not `undefined` — is how these helpers spell "send no key at all".
 * A default parameter is applied when the argument IS `undefined`, so
 * `callTool(args, tool, undefined)` silently sends the correct secret and the
 * refusal assertion passes while testing nothing. It did exactly that once.
 */
type Key = string | null | undefined;

/** The context callback, as FluxyChat's fetchAppContext makes it. */
async function fetchContext(
  userId: string,
  roomId: string,
  key: Key = SECRET
): Promise<Response> {
  const url = new URL('http://example.com/api/chat/webhook/context');
  if (key != null) url.searchParams.set('k', key);
  url.searchParams.set('projectId', 'proj');
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('userId', userId);
  return exports.default.fetch(new Request(url.toString()));
}

/** The tool callback, in the wire shape executeToolCall actually posts. */
async function callTool(
  args: Record<string, unknown>,
  toolName = 'get_pipeline_status',
  key: Key = SECRET
): Promise<Response> {
  const url = new URL('http://example.com/api/chat/webhook/tools/execute');
  if (key != null) url.searchParams.set('k', key);
  return exports.default.fetch(
    new Request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: toolName,
        arguments: args,
        tool_call_id: 'call-1',
        dry_run: false,
      }),
    })
  );
}

async function tokenFor(userId: string): Promise<string> {
  const res = await fetchContext(userId, `support-${userId}`);
  expect(res.status).toBe(200);
  const body = await res.json<{ session_token: string }>();
  return body.session_token;
}

beforeAll(async () => {
  await seedUser(VICTIM);
  await seedUser(ATTACKER);
  // A run belonging to the victim, so a successful cross-tenant read would
  // return something recognisably theirs rather than an empty result that
  // looks the same as a refusal.
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO pipeline_runs (id, user_id, project_id, prompt, status, execution_mode, started_at, created_date, updated_date, created_by)
     VALUES ('run-victim', ?, 'proj-victim', 'the victim private prompt', 'implementing', 'ask_first', ?, ?, ?, ?)`
  )
    .bind(VICTIM, now, now, now, VICTIM)
    .run();

  // A project and one lattice node belonging to the victim. The lattice tool
  // takes a project_id, so there has to be a real, owned project id for an
  // attacker to name.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO projects (id, user_id, name, created_date, updated_date, created_by)
     VALUES ('proj-victim', ?, 'Victim App', ?, ?, ?)`
  )
    .bind(VICTIM, now, now, VICTIM)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO lattice_nodes (id, project_id, type, label, metadata, created_date, updated_date, created_by)
     VALUES ('node-victim', 'proj-victim', 'decision', 'victim auth decision', '{"agent_role":"designer"}', ?, ?, ?)`
  )
    .bind(now, now, VICTIM)
    .run();
});

describe('the webhook reads the wire shape FluxyChat actually sends', () => {
  it('dispatches on tool_name', async () => {
    const res = await callTool({ session_token: await tokenFor(VICTIM) });
    expect(res.status).toBe(200);
    // Defect C: with `body.name` this was 400 "Unknown tool: (none)" for every
    // call ever made.
    const body = await res.json<{ result: unknown }>();
    expect(body.result).toBeDefined();
  });

  it('rejects the legacy `name` field rather than quietly accepting both', async () => {
    const url = new URL('http://example.com/api/chat/webhook/tools/execute');
    url.searchParams.set('k', SECRET!);
    const res = await exports.default.fetch(
      new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'get_pipeline_status',
          arguments: { session_token: await tokenFor(VICTIM) },
        }),
      })
    );
    // Accepting both would leave the broken contract alive as a fallback, and
    // the next reader could not tell which one FluxyChat relies on.
    expect(res.status).toBe(400);
  });
});

describe('identity comes from the token, never from the arguments', () => {
  it('ignores a user_id supplied in the tool arguments', async () => {
    // Defect D, stated directly: the attacker holds their own valid token and
    // additionally names the victim. The victim's id must not be honoured.
    const res = await callTool({
      session_token: await tokenFor(ATTACKER),
      user_id: VICTIM,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { active: boolean } }>();
    // The attacker has no runs; the victim has one implementing. If the
    // argument were honoured this would describe the victim's run.
    expect(body.result.active).toBe(false);
  });

  it('refuses a call with no token at all', async () => {
    const res = await callTool({ user_id: VICTIM });
    expect(res.status).toBe(401);
  });

  it('refuses a forged token', async () => {
    const res = await callTool({ session_token: 'f'.repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe('search_memory_lattice is scoped to the token holder', () => {
  it('returns the caller own nodes', async () => {
    const res = await callTool(
      { session_token: await tokenFor(VICTIM), query: 'auth' },
      'search_memory_lattice'
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { nodes: { label: string }[] } }>();
    expect(body.result.nodes.map((n) => n.label)).toContain(
      'victim auth decision'
    );
  });

  it('cannot be widened to another founder project by naming its id', async () => {
    // The whole point of the tool taking a project_id: it may narrow a set
    // already joined on the caller, and may never select a different one. If
    // the ownership join were ever moved behind an `if (projectId)` branch,
    // this is the assertion that fails.
    const res = await callTool(
      { session_token: await tokenFor(ATTACKER), project_id: 'proj-victim' },
      'search_memory_lattice'
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      result: { nodes: unknown[]; projectId: string | null };
    }>();
    expect(body.result.nodes).toEqual([]);
    expect(body.result.projectId).toBeNull();
  });

  it('refuses a lattice search with no token', async () => {
    const res = await callTool({ query: 'auth' }, 'search_memory_lattice');
    expect(res.status).toBe(401);
  });
});

describe('the callback secret is required on both webhooks', () => {
  it('refuses a tool call with no key', async () => {
    const res = await callTool(
      { session_token: await tokenFor(VICTIM) },
      'get_pipeline_status',
      null
    );
    expect(res.status).toBe(401);
  });

  it('refuses a context fetch with a wrong key', async () => {
    const res = await fetchContext(VICTIM, `support-${VICTIM}`, 'not-the-key');
    expect(res.status).toBe(401);
  });

  it('refuses a context fetch whose room belongs to someone else', async () => {
    // Defence in depth: the key already proves the caller is FluxyChat, but a
    // mismatched pair means something upstream is confused, and minting a token
    // anyway would hand out the wrong founder's identity.
    const res = await fetchContext(ATTACKER, `support-${VICTIM}`);
    expect(res.status).toBe(401);
  });
});

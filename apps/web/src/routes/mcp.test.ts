/**
 * The MCP server delegates. That is the claim, and it is the only one worth a
 * test — everything else about this endpoint follows from it.
 *
 * If the tools really re-enter the same app, then tier checks, credit debits,
 * rate limits and response shapes are the HTTP API's, unchanged, and there is
 * nothing to keep in sync. If they do not — if any tool ever reaches D1 or a
 * Durable Object directly — then there are two implementations of one contract
 * and they will drift, which is the defect this codebase keeps finding in
 * itself.
 *
 * So the tests below check the delegation itself: the request that goes out,
 * not a restatement of the response that comes back. Comparing a tool's output
 * to a fixture would pass just as well for a reimplementation.
 *
 * EVERY POSITIVE ASSERTION HERE HAS A NEGATIVE CONTROL BESIDE IT. A check that
 * has only been seen to pass is decoration; the controls perturb something the
 * code actually reads and assert the result changes.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  INTERNAL_DELEGATION_HEADER,
  INTERNAL_DELEGATION_NONCE,
} from '../lib/require-auth.js';
import {
  createMcpRoutes,
  MCP_TOOLS,
  MCP_REACHABLE,
  MCP_PROTOCOL_VERSION,
  assertChargedOnce,
  type McpFetcher,
} from './mcp.js';

/** A fetcher that records what was asked of it and answers with a sentinel. */
function recorder(body: unknown = { ok: true }, status = 200) {
  const seen: Request[] = [];
  const fn: McpFetcher = async (req) => {
    seen.push(req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { seen, fetcher: fn };
}

function server(fetcher: McpFetcher) {
  const app = new Hono();
  app.route('/mcp', createMcpRoutes(fetcher));
  return app;
}

async function rpc(
  app: Hono,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('the tools reach the real routes, and nothing else', () => {
  it('get_project issues GET against the projects route', async () => {
    const { seen, fetcher } = recorder();
    await rpc(server(fetcher), call('get_project', { id: 'abc-123' }));

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(new URL(seen[0].url).pathname).toBe('/api/projects/abc-123');
  });

  it('generate_app POSTs the prompt to the generate route', async () => {
    const { seen, fetcher } = recorder({ id: 'gen-1' }, 201);
    await rpc(server(fetcher), call('generate_app', { prompt: 'a todo app' }));

    expect(seen[0].method).toBe('POST');
    expect(new URL(seen[0].url).pathname).toBe('/api/generate');
    expect(await seen[0].json()).toEqual({
      prompt: 'a todo app',
      projectId: undefined,
    });
  });

  it("carries the caller's Authorization through, unchanged", async () => {
    /*
     * The whole auth story. The delegated request is the CALLER'S request —
     * their key, their tier, their credits — not a privileged internal one. Drop
     * this header and every tool would run as whatever the internal fetch
     * defaults to, which is the largest hole this endpoint could have.
     */
    const { seen, fetcher } = recorder();
    await rpc(server(fetcher), call('list_projects'), {
      authorization: 'Bearer vk_test_key',
    });
    expect(seen[0].headers.get('authorization')).toBe('Bearer vk_test_key');
  });

  it('NEGATIVE CONTROL: with no Authorization, none is invented', async () => {
    // The inverse of the assertion above. If the dispatcher ever synthesised a
    // header, the positive test would still pass and the endpoint would be
    // unauthenticated. This is the case that catches that.
    const { seen, fetcher } = recorder();
    await rpc(server(fetcher), call('list_projects'));
    expect(seen[0].headers.get('authorization')).toBeNull();
  });

  it('returns the delegated body verbatim', async () => {
    const { fetcher } = recorder({ sentinel: 'from-the-route' });
    const { json } = await rpc(server(fetcher), call('site_health'));
    expect(json.result.content[0].text).toContain('from-the-route');
    expect(json.result.isError).toBe(false);
  });

  it('NEGATIVE CONTROL: change what the route returns and the tool changes', async () => {
    /*
     * The delegation claim, tested as a difference rather than as a match. A
     * reimplementation would pass the previous test against a fixture and fail
     * this one, because its output would not move when the route's did.
     */
    const a = await rpc(
      server(recorder({ v: 'first' }).fetcher),
      call('site_health')
    );
    const b = await rpc(
      server(recorder({ v: 'second' }).fetcher),
      call('site_health')
    );
    expect(a.json.result.content[0].text).not.toBe(
      b.json.result.content[0].text
    );
    expect(b.json.result.content[0].text).toContain('second');
  });
});

describe('a path cannot be steered out of the allowlist', () => {
  it('escapes traversal in an id instead of following it', async () => {
    const { seen, fetcher } = recorder();
    await rpc(server(fetcher), call('get_project', { id: '../admin/promote' }));

    const path = new URL(seen[0].url).pathname;
    expect(path.startsWith('/api/projects/')).toBe(true);
    expect(path).not.toContain('/api/admin');
  });

  it('cannot be made to re-enter /mcp, which would recurse', async () => {
    const { seen, fetcher } = recorder();
    await rpc(server(fetcher), call('generation_status', { id: '../../mcp' }));
    expect(new URL(seen[0].url).pathname).not.toBe('/mcp');
  });

  it('NEGATIVE CONTROL: the allowlist refuses a path outside it', async () => {
    /*
     * Perturbs the thing the dispatcher actually reads. The tool table is
     * checked against MCP_REACHABLE at dispatch time, so a tool pointed
     * somewhere unlisted must be refused BEFORE the request is issued — and the
     * assertion that matters is that `seen` stays empty, not merely that the
     * response says 403.
     */
    const { seen, fetcher } = recorder();
    const rogue = {
      ...MCP_TOOLS[0],
      name: 'rogue',
      path: () => '/api/admin/users',
    };
    const app = new Hono();
    app.route('/mcp', createMcpRoutes(fetcher));
    // Reach the dispatcher directly: the rogue tool is not in the public table,
    // which is itself the first line of defence.
    const { dispatch } = await import('./mcp.js');
    const out = await dispatch(
      rogue as any,
      {},
      new Request('https://discomplemented.com/mcp'),
      {} as any,
      { waitUntil() {}, passThroughOnException() {} },
      fetcher
    );
    expect(out.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(out.text).toContain('outside the paths');
  });

  it('every declared tool resolves inside the allowlist', () => {
    // The table and the allowlist are separate lists, so they can disagree.
    // This is the assertion that says they do not, for every tool, today.
    for (const tool of MCP_TOOLS) {
      const path = tool.path({ id: 'x' });
      const ok = MCP_REACHABLE.some(
        (p) => path === p || path.startsWith(p + '/')
      );
      expect(
        ok,
        `${tool.name} resolves to ${path}, outside MCP_REACHABLE`
      ).toBe(true);
    }
  });
});

describe('JSON-RPC, as clients actually speak it', () => {
  it('initialize echoes a version it supports', async () => {
    const { json } = await rpc(server(recorder().fetcher), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect(json.result.protocolVersion).toBe('2024-11-05');
    expect(json.result.serverInfo.name).toBe('discomplemented.com');
  });

  it('NEGATIVE CONTROL: it does NOT echo a version it has never seen', async () => {
    /*
     * A server that echoes whatever arrives looks compatible with everything
     * and is compatible with nothing: the client then holds it to a spec it has
     * never implemented, and the failure lands somewhere unrelated much later.
     */
    const { json } = await rpc(server(recorder().fetcher), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    expect(json.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('a notification gets no response body', async () => {
    const res = await server(recorder().fetcher).request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('tools/list names every tool with a schema', async () => {
    const { json } = await rpc(server(recorder().fetcher), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(json.result.tools).toHaveLength(MCP_TOOLS.length);
    for (const t of json.result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.description).toBe('string');
    }
  });

  it('a missing required argument is a PARAMS error, not a tool run', async () => {
    const { seen, fetcher } = recorder();
    const { json } = await rpc(server(fetcher), call('get_project', {}));
    expect(json.error.code).toBe(-32602);
    expect(seen).toHaveLength(0);
  });

  it('an unknown tool is an error, not a silent success', async () => {
    const { json } = await rpc(
      server(recorder().fetcher),
      call('drop_database')
    );
    expect(json.error.code).toBe(-32602);
  });

  it('a 4xx from the route is a TOOL error, not a protocol error', async () => {
    /*
     * The distinction a client acts on. `isError` means the call failed and here
     * is why — out of credits, tier too low, not found — so the model can adapt.
     * A JSON-RPC error means the REQUEST was malformed and retrying the same
     * shape is pointless. Collapsing them is how a client retries an unpayable
     * generation until the rate limit bites.
     */
    const { fetcher } = recorder({ error: 'Insufficient credits' }, 402);
    const { json } = await rpc(
      server(fetcher),
      call('generate_app', { prompt: 'x' })
    );
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain('Insufficient credits');
  });

  it('malformed JSON is a parse error', async () => {
    const res = await server(recorder().fetcher).request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32700);
  });

  it('GET says there is no stream rather than hanging', async () => {
    const res = await server(recorder().fetcher).request('/mcp');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('a batch gets an array back, one entry per request', async () => {
    const { json } = await rpc(server(recorder().fetcher), [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    expect(Array.isArray(json)).toBe(true);
    // Three in, two out: the notification is correctly unanswered.
    expect(json).toHaveLength(2);
    expect(json.map((r: any) => r.id)).toEqual([1, 2]);
  });
});

describe('the rate limit is charged once per tool call, not twice', () => {
  /*
   * The defect the independent auditor found on the commit that introduced this
   * file, and that the original 20 tests could not have found: they measure the
   * request that goes out, and this is a property of that request going out
   * TWICE. `requireAuth` runs at /mcp and again on the delegated route, and
   * `checkRateLimit` does `request_count = request_count + 1`, so a tier
   * documented at N requests per hour delivered N/2 tool calls.
   */
  it('marks the delegated request so requireAuth does not re-charge it', async () => {
    const { seen, fetcher } = recorder();
    await rpc(server(fetcher), call('list_projects'), {
      authorization: 'Bearer vk_test_key',
    });
    expect(seen[0].headers.get(INTERNAL_DELEGATION_HEADER)).toBe(
      INTERNAL_DELEGATION_NONCE
    );
  });

  it('NEGATIVE CONTROL: the marker is not a constant anyone can guess', () => {
    /*
     * A fixed header value would be a rate-limit bypass for every route in the
     * Worker, available to anyone who read the source. The nonce is generated
     * per isolate; this asserts it is not the header name, not empty, and not a
     * short literal — the three shapes a hand-written constant takes.
     */
    expect(INTERNAL_DELEGATION_NONCE).not.toBe(INTERNAL_DELEGATION_HEADER);
    expect(INTERNAL_DELEGATION_NONCE.length).toBeGreaterThan(20);
    expect(INTERNAL_DELEGATION_NONCE).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('NEGATIVE CONTROL: a client-supplied marker never reaches the route', async () => {
    /*
     * The attack the nonce defends against, tested rather than argued. A caller
     * sets the header on the JSON-RPC request itself; `dispatch()` builds the
     * delegated headers from scratch, so what arrives is the real nonce and not
     * the attacker's value — and if `dispatch` ever started forwarding headers
     * wholesale, this is the test that goes red.
     */
    const { seen, fetcher } = recorder();
    await rpc(server(fetcher), call('list_projects'), {
      [INTERNAL_DELEGATION_HEADER]: 'forged-by-the-client',
    });
    expect(seen[0].headers.get(INTERNAL_DELEGATION_HEADER)).not.toBe(
      'forged-by-the-client'
    );
  });
});

describe('id: null is one consistent rejection, not a split', () => {
  /*
   * Also the auditor's. `initialize` with `id: null` returned a result while
   * `tools/list` with `id: null` returned 202 and silence — so a client waiting
   * on the second hangs, and a hang looks like a dead server rather than a
   * rejected request. MCP forbids a null id; the answer is the same error for
   * every method.
   */
  for (const method of ['initialize', 'tools/list', 'ping']) {
    it(`${method} with id:null is rejected, not answered and not ignored`, async () => {
      const { json } = await rpc(server(recorder().fetcher), {
        jsonrpc: '2.0',
        id: null,
        method,
      });
      expect(json).not.toBeNull();
      expect(json.error.code).toBe(-32600);
      expect(json.result).toBeUndefined();
    });
  }

  it('a MALFORMED request with id:null is still an error, not silence', async () => {
    /*
     * Added because a mutation survived. Reverting `isNotification` to
     * `id === undefined || id === null` left every other test green: the
     * explicit `id === null` guard sits AFTER the jsonrpc-validity check, so it
     * covers well-formed requests only. A malformed one with `id: null` went
     * back to silence, and silence is the hang this whole section exists to
     * remove. The mutant was equivalent for the inputs the suite had; it is not
     * equivalent for this one.
     */
    const { json } = await rpc(server(recorder().fetcher), {
      jsonrpc: 'not-2.0',
      id: null,
      method: 'tools/list',
    });
    expect(json).not.toBeNull();
    expect(json.error.code).toBe(-32600);
  });

  it('NEGATIVE CONTROL: a real notification (no id field) is still silent', async () => {
    /*
     * The property the fix must not break. A notification has NO `id` key —
     * that is what distinguishes it from `id: null` — and answering one makes
     * strict clients error on a response they never asked for.
     */
    const res = await server(recorder().fetcher).request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});

describe('a double charge is detected, not assumed away', () => {
  /*
   * The guard that replaced one that could not fail. An earlier commit branded
   * the fetcher with a `unique symbol` and claimed a cross-isolate fetcher
   * "fails to compile"; the independent auditor pointed out that the branding
   * function was an identity cast which would brand `env.SELF.fetch` just as
   * happily. A guard that cannot return a negative result is decoration, so it
   * was deleted and replaced with this, which observes the delegated response.
   */
  const withHeader = (value: string | null) => ({
    headers: { get: () => value },
  });

  it('no fault when the skip took effect', () => {
    expect(assertChargedOnce(withHeader('-1'))).toBeNull();
  });

  it('no fault when requireAuth did not run at all', () => {
    // A public route such as /api/healthz sets no such header. Asserting here
    // would be the vacuous control — perturbing something the system ignores.
    expect(assertChargedOnce(withHeader(null))).toBeNull();
  });

  it('NEGATIVE CONTROL: a real remaining count IS the double charge', () => {
    /*
     * The case the whole mechanism exists for. `X-Rate-Limit-Remaining: 499`
     * means `checkRateLimit` ran on the delegated request, which means the
     * marker did not reach it, which means this tool call cost two tokens.
     */
    const fault = assertChargedOnce(withHeader('499'));
    expect(fault).toContain('CHARGED TWICE');
    expect(fault).toContain('different isolate');
  });

  it('the fault reaches the caller, not just the log', async () => {
    const seen: Request[] = [];
    const fetcher: McpFetcher = async (req) => {
      seen.push(req);
      return new Response('{}', {
        status: 200,
        headers: { 'X-Rate-Limit-Remaining': '499' },
      });
    };
    const { json } = await rpc(server(fetcher), call('site_health'));
    const texts = json.result.content.map((c: any) => c.text).join(' ');
    expect(texts).toContain('CHARGED TWICE');
    // The tool call still succeeded. An over-charge is not a reason to throw
    // away a result the caller has already paid for -- twice.
    expect(json.result.isError).toBe(false);
  });
});

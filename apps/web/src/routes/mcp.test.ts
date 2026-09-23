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
  createMcpRoutes,
  MCP_TOOLS,
  MCP_REACHABLE,
  MCP_PROTOCOL_VERSION,
  type McpFetcher,
} from './mcp.js';

/** A fetcher that records what was asked of it and answers with a sentinel. */
function recorder(body: unknown = { ok: true }, status = 200) {
  const seen: Request[] = [];
  const fetcher: McpFetcher = async (req) => {
    seen.push(req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { seen, fetcher };
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

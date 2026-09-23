/**
 * The discomplemented.com MCP server.
 *
 * ONE ARCHITECTURAL DECISION, AND IT IS THE WHOLE FILE: this is a TRANSPORT,
 * not a second API.
 *
 * Every tool below resolves to an existing HTTP route and is executed by
 * building a Request and handing it to the same Hono app that serves
 * discomplemented.com. Nothing is reimplemented. The alternative — an MCP layer
 * that talks to D1 and the Durable Objects directly — was rejected because it
 * produces two implementations of one contract, and two implementations of one
 * contract drift. That is `C-573` in the parent plan and it is the defect this
 * codebase keeps finding in itself; building a fresh instance of it to expose
 * the product over a second protocol would be choosing it deliberately.
 *
 * The consequences of that decision are the reason it is worth it:
 *
 *   · Auth is not re-implemented. `requireAuth` runs on the delegated request
 *     exactly as it runs on the HTTP one, so a virtual key's tier, ban state,
 *     trial expiry, rate limit and credit balance all apply unchanged. There is
 *     no MCP-shaped hole in the auth model because there is no MCP auth model.
 *   · Entitlements, credit debits and telemetry are not re-implemented either.
 *     `generate` debits credits because `/api/generate` debits credits.
 *   · A route changing its response shape changes the tool's output in the same
 *     commit. They cannot disagree.
 *
 * WHAT THIS COSTS, stated rather than discovered later. A tool can only do what
 * a route already does. Anything the HTTP API cannot express, this cannot
 * expose — and the correct fix is to add the route, not to reach around it.
 *
 * TRANSPORT. MCP Streamable HTTP, JSON-RPC 2.0 over POST. Responses are plain
 * `application/json` rather than SSE: every tool here is a single
 * request/response with no server-initiated messages, and the spec permits a
 * JSON response for exactly that case. GET returns 405 with `Allow: POST`,
 * which is the documented way to say "this server has no SSE stream" rather
 * than leaving a client hanging on a connection that will never emit.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

/**
 * The two members of `ExecutionContext` this file ever touches — which is none.
 *
 * `ExecutionContext` from workers-types is generic and Hono's `c.executionCtx`
 * resolves to a differently-parameterised instantiation of it; the two are not
 * mutually assignable, and a union of them collapses rather than accepting
 * either. This module only PASSES THE CONTEXT THROUGH to `app.fetch`, so it is
 * typed by the surface it actually needs instead of by a name that means two
 * things. That keeps the one unavoidable cast at the mount point in index.ts,
 * where a reader can see it, rather than spread across every dispatch.
 */
export interface McpExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export type McpFetcher = (
  req: Request,
  env: Env,
  ctx: McpExecutionContext
) => Response | Promise<Response>;

/** JSON-RPC 2.0, the subset this server speaks. */
interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Standard JSON-RPC error codes, plus the one MCP adds.
 *
 * These are not decorative. A client distinguishes "you asked for a tool that
 * does not exist" (-32601) from "the tool ran and failed" (an `isError` result),
 * and collapsing the two is how a caller ends up retrying a typo forever.
 */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * The protocol version this server implements.
 *
 * Echoed back verbatim in `initialize` only when the client asked for a version
 * this server actually speaks. A server that echoes whatever the client sent is
 * claiming to implement a spec it has never seen.
 */
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([
  PROTOCOL_VERSION,
  '2025-03-26',
  '2024-11-05',
]);

/**
 * A tool: a name, a schema, and the route it delegates to.
 *
 * `method` and `path` are the whole implementation. `path` may be a function of
 * the arguments, which is how `/api/projects/:id` is addressed without a router
 * of its own. `body` selects which arguments travel as JSON.
 */
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  /** True when the tool cannot change state — surfaced to the client as a hint. */
  readOnly: boolean;
  method: 'GET' | 'POST';
  path: (args: Record<string, unknown>) => string;
  body?: (args: Record<string, unknown>) => unknown;
}

/**
 * Every path a tool may reach, as a literal prefix list.
 *
 * AN ALLOWLIST, NOT A DENYLIST, AND NOT AN ACCIDENT. `dispatch()` re-fetches
 * through the same app that mounts `/mcp`, so a tool whose path could be
 * influenced into naming `/mcp` would recurse until the isolate died — and a
 * path that could reach `/api/admin` would hand an MCP client the admin surface
 * without anyone deciding to. Neither is possible today because every `path()`
 * below is a template over escaped arguments, but "not possible today" is a
 * property of the current tool list rather than of the dispatcher. This is
 * checked in the dispatcher, where it stays true as tools are added.
 */
const REACHABLE = [
  '/api/healthz',
  '/api/entitlements',
  '/api/projects',
  '/api/usage',
  '/api/compliance',
  '/api/generate',
  '/api/pipeline',
];

/**
 * A path segment, made safe to interpolate.
 *
 * `encodeURIComponent` escapes `/`, `?` and `#`, so an id of
 * `../admin/promote` cannot become a path of its own. The allowlist in
 * `dispatch()` is the second layer; this is the first, and neither is trusted
 * to be the only one.
 */
function seg(v: unknown): string {
  return encodeURIComponent(String(v ?? ''));
}

const TOOLS: Tool[] = [
  {
    name: 'site_health',
    title: 'Site health',
    description:
      'Liveness of the discomplemented.com Worker, with the environment it ' +
      'believes it is running in. Use this first when something looks wrong: ' +
      'it distinguishes "the deployment is down" from "your key is rejected".',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    method: 'GET',
    path: () => '/api/healthz',
  },
  {
    name: 'entitlements',
    title: 'What this key is entitled to',
    description:
      "The calling key's tier and the limits that follow from it. Answers " +
      '"why was that refused" without guessing — a refusal is a tier, a ' +
      'credit balance or a rate limit, and this says which.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    method: 'GET',
    path: () => '/api/entitlements',
  },
  {
    name: 'usage_summary',
    title: 'Usage and credits',
    description:
      'Credits remaining and consumption for the calling key. Read this ' +
      'before `generate_app`: a generation that cannot be paid for fails ' +
      'after the prompt is accepted, not before.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    method: 'GET',
    path: () => '/api/usage',
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Every project owned by the calling key.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    method: 'GET',
    path: () => '/api/projects',
  },
  {
    name: 'get_project',
    title: 'Get one project',
    description: 'One project by id, including its files when it has any.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project id (a UUID).' },
      },
      required: ['id'],
    },
    readOnly: true,
    method: 'GET',
    path: (a) => `/api/projects/${seg(a.id)}`,
  },
  {
    name: 'create_project',
    title: 'Create a project',
    description: 'A named container for generated applications.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name.' },
        description: { type: 'string', description: 'Optional description.' },
      },
      required: ['name'],
    },
    readOnly: false,
    method: 'POST',
    path: () => '/api/projects',
    body: (a) => ({ name: a.name, description: a.description }),
  },
  {
    name: 'compliance_snapshot',
    title: 'Compliance snapshot',
    description:
      'The public compliance surface the site publishes about itself — the ' +
      'same record `/compliance` renders, read through the API rather than ' +
      'scraped from the page.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    method: 'GET',
    path: () => '/api/compliance',
  },
  {
    name: 'generate_app',
    title: 'Generate an application',
    description:
      'THIS SPENDS CREDITS AND RUNS THE REAL PIPELINE. Submits a prompt and ' +
      'returns a generation id; the work continues after this returns. Poll ' +
      '`generation_status` with that id. Call `usage_summary` first if the ' +
      'balance is unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to build.' },
        projectId: {
          type: 'string',
          description: 'Optional project to attach the generation to.',
        },
      },
      required: ['prompt'],
    },
    readOnly: false,
    method: 'POST',
    path: () => '/api/generate',
    body: (a) => ({ prompt: a.prompt, projectId: a.projectId }),
  },
  {
    name: 'generation_status',
    title: 'Generation status',
    description:
      'State of one pipeline run by id. A run that has not finished is not a ' +
      'run that failed — the status says which.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Pipeline run id.' } },
      required: ['id'],
    },
    readOnly: true,
    method: 'GET',
    path: (a) => `/api/pipeline/${seg(a.id)}`,
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Run a tool by re-entering the app that mounts this route.
 *
 * `fetcher` is the app's own `fetch`, injected rather than imported, because
 * `index.ts` imports this module — importing it back would be a cycle, and a
 * cycle in a Workers bundle is a `undefined is not a function` at the first
 * request rather than a build error.
 */
export async function dispatch(
  tool: Tool,
  args: Record<string, unknown>,
  req: Request,
  env: Env,
  ctx: McpExecutionContext,
  fetcher: McpFetcher
): Promise<{ status: number; text: string }> {
  const path = tool.path(args);

  if (!REACHABLE.some((p) => path === p || path.startsWith(p + '/'))) {
    // Not reachable is not the same as not found: this is the dispatcher
    // refusing to issue the request at all, and saying so plainly beats a 404
    // that looks like a missing route.
    return {
      status: 403,
      text: JSON.stringify({
        error:
          `tool '${tool.name}' resolved to ${path}, which is outside the ` +
          'paths MCP tools may reach',
      }),
    };
  }

  const url = new URL(req.url);
  url.pathname = path;
  url.search = '';

  const headers = new Headers();
  // Auth travels verbatim. A tool call is the caller's request, made on the
  // caller's behalf, with the caller's entitlements — not a privileged internal
  // one. Copying only these two headers is deliberate: forwarding the whole set
  // would carry `content-length` from the JSON-RPC envelope onto a body that is
  // a different length.
  const auth = req.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  const cookie = req.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  headers.set('accept', 'application/json');

  let body: string | undefined;
  if (tool.method === 'POST') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(tool.body ? tool.body(args) : {});
  }

  const res = await fetcher(
    new Request(url.toString(), { method: tool.method, headers, body }),
    env,
    ctx
  );
  return { status: res.status, text: await res.text() };
}

/**
 * The execution context, or a working stand-in.
 *
 * `c.executionCtx` THROWS when Hono has none — it is a getter with a
 * `This context has no ExecutionContext` inside it, not a property that returns
 * undefined. Every tool call read it unguarded and the whole endpoint answered
 * `500 Internal Server Error` in any environment that does not supply one. The
 * Workers runtime always supplies one, so this would never have shown up in
 * production traffic; it showed up the first time the tests ran, which is the
 * argument for having run them.
 *
 * A no-op stand-in is correct rather than a patch over a symptom: nothing in
 * this module uses `waitUntil` or `passThroughOnException`. The context is
 * accepted and passed through so the DELEGATED route can use it, and a route
 * that schedules background work through a no-op simply does that work inline.
 * Refusing the request instead would trade a real failure for a certain one.
 */
function safeCtx(c: {
  executionCtx: McpExecutionContext;
}): McpExecutionContext {
  try {
    return c.executionCtx;
  } catch {
    return { waitUntil() {}, passThroughOnException() {} };
  }
}

function rpcError(id: RpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: RpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Build the MCP router.
 *
 * Takes the app's `fetch` so tools can re-enter it without an import cycle.
 */
export function createMcpRoutes(fetcher: McpFetcher) {
  const mcp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  /*
   * No SSE stream, said explicitly.
   *
   * The spec allows a server to offer GET for server-initiated messages. This
   * one has none — every tool is a single request/response — so it returns 405
   * with `Allow: POST` rather than opening a stream that will never emit. A
   * client hanging on a silent connection is indistinguishable from a client
   * talking to a broken server, and this is the difference.
   */
  mcp.get('/', (c) =>
    c.json(
      {
        error: 'This MCP server is POST-only: no server-initiated messages.',
        transport: 'streamable-http',
        protocolVersion: PROTOCOL_VERSION,
      },
      405,
      { Allow: 'POST' }
    )
  );

  mcp.post('/', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        rpcError(null, PARSE_ERROR, 'Request body is not valid JSON'),
        400
      );
    }

    // Batches are part of JSON-RPC and clients do send them.
    const batch = Array.isArray(payload);
    const requests: RpcRequest[] = batch
      ? (payload as RpcRequest[])
      : [payload as RpcRequest];
    if (batch && requests.length === 0) {
      return c.json(rpcError(null, INVALID_REQUEST, 'Empty batch'), 400);
    }

    const out: unknown[] = [];
    for (const rpc of requests) {
      const handled = await handle(rpc, c.req.raw, c.env, safeCtx(c), fetcher);
      // A notification has no id and gets no response, per JSON-RPC. Returning
      // one for `notifications/initialized` makes strict clients error on a
      // response they never asked for.
      if (handled !== null) out.push(handled);
    }

    if (out.length === 0) return c.body(null, 202);
    return c.json(batch ? out : out[0]);
  });

  return mcp;
}

async function handle(
  rpc: RpcRequest,
  req: Request,
  env: Env,
  ctx: McpExecutionContext,
  fetcher: McpFetcher
): Promise<unknown | null> {
  const id = rpc?.id;
  const isNotification = id === undefined || id === null;

  if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return isNotification
      ? null
      : rpcError(id, INVALID_REQUEST, 'Not a JSON-RPC 2.0 request');
  }

  switch (rpc.method) {
    case 'initialize': {
      const asked = (rpc.params?.protocolVersion as string) || PROTOCOL_VERSION;
      /*
       * Echo the client's version only when it is one this server speaks.
       * Echoing whatever arrives is the easy way to look compatible with
       * everything and be compatible with nothing: the client then holds the
       * server to a spec the server has never implemented, and the failure
       * lands somewhere unrelated much later.
       */
      const version = SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'discomplemented.com', version: '1.0.0' },
        instructions:
          'Tools here are the discomplemented.com HTTP API, reached over MCP. ' +
          'Authenticate with `Authorization: Bearer <virtual key>` — the same ' +
          'key the REST API takes. Tier, credits and rate limits apply ' +
          'identically because they are the same code path. `generate_app` ' +
          'spends credits and starts a real pipeline run.',
      });
    }

    // Notifications: acknowledged by returning nothing, which is what the
    // protocol asks for.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
        })),
      });

    case 'tools/call': {
      const name = rpc.params?.name as string | undefined;
      const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};
      const tool = name ? BY_NAME.get(name) : undefined;
      if (!tool) {
        return rpcError(
          id,
          INVALID_PARAMS,
          `Unknown tool: ${name ?? '(none)'}`
        );
      }
      for (const required of tool.inputSchema.required ?? []) {
        if (
          args[required] === undefined ||
          args[required] === null ||
          args[required] === ''
        ) {
          return rpcError(
            id,
            INVALID_PARAMS,
            `Missing required argument: ${required}`
          );
        }
      }

      try {
        const { status, text } = await dispatch(
          tool,
          args,
          req,
          env,
          ctx,
          fetcher
        );
        /*
         * A FAILING ROUTE IS A TOOL RESULT, NOT A PROTOCOL ERROR.
         *
         * `isError: true` tells the model the call failed and hands it the
         * body so it can act — out of credits, tier too low, project not
         * found. A JSON-RPC error means the REQUEST was malformed and the
         * model should stop, not retry differently. Collapsing the two is how
         * a client retries an unpayable generation until the rate limit bites.
         */
        return rpcResult(id, {
          content: [{ type: 'text', text }],
          isError: status >= 400,
        });
      } catch (err) {
        return rpcError(
          id,
          INTERNAL_ERROR,
          err instanceof Error ? err.message : 'Tool dispatch failed'
        );
      }
    }

    default:
      return isNotification
        ? null
        : rpcError(id, METHOD_NOT_FOUND, `Unsupported method: ${rpc.method}`);
  }
}

/** Exported for tests. The list a client sees is the list the tests measure. */
export const MCP_TOOLS = TOOLS;
export const MCP_REACHABLE = REACHABLE;
export const MCP_PROTOCOL_VERSION = PROTOCOL_VERSION;

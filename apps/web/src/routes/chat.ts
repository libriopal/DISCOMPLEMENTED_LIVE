/**
 * Chat — Phase 8. Bridges Bicameral to the self-hosted FluxyChat Worker
 * (see @agent_docs/live-chat.md): mints member sessions for the frontend
 * widget and answers the pipeline-status tool the Cohere-backed support
 * agent calls mid-conversation.
 *
 * `chatRoutes` is mounted under /api/chat *after* the global requireAuth in
 * index.ts — every call is a logged-in founder minting their own session.
 * `chatWebhookRoutes` is mounted *before* requireAuth (like /api/auth)
 * because the caller is the FluxyChat Worker itself, not a Bicameral
 * session. It authenticates on a shared secret in the callback URL
 * (see lib/fluxychat.ts verifyWebhookKey) and establishes WHICH founder the
 * call is for from a capability token (see lib/chat-tool-token.ts) — two
 * distinct questions, neither of which the other answers.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AuthError,
  BicameralError,
  ValidationError,
} from '@bicameral/shared/errors';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import {
  mintChatSession,
  getPipelineStatusForUser,
  verifyWebhookKey,
  escalateToHuman,
  supportRoomId,
} from '../lib/fluxychat.js';
import { assertChatMintQuota, recordChatMint } from '../lib/chat-quota.js';
import {
  mintChatToolToken,
  resolveChatToolToken,
} from '../lib/chat-tool-token.js';
import { fetchLatticeContext } from '../lib/lattice-context.js';

export const chatRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

// ============ POST /api/chat/token ============
chatRoutes.post('/token', async (c) => {
  const userId = c.get('userId');

  // Checks the USER key, which is the one mintChatSession presents — not the
  // admin key. Guarding a user path on the presence of an admin credential
  // reads as a configuration check and is really a coupling: it would answer
  // 200-then-500 once the admin key was set and the user key was not, and it
  // would answer 503 for a correctly configured user tier if the admin key
  // were ever rotated out. The guard has to name the credential in play.
  //
  // The Worker IS deployed as of 2026-08-31 (fluxychat.johnathanallen1998
  // .workers.dev, /health reports database/durableObjects/kv/r2 connected), so
  // an unset key is now a misconfiguration rather than the expected state.
  // Still 503 and not 500: the widget already renders "Support chat is
  // unavailable right now." for any !res.ok, and a 500 would file every widget
  // open as a server fault in telemetry.
  if (!c.env.FLUXYCHAT_USER_API_KEY) {
    throw new BicameralError(
      'Live chat is not configured',
      'CHAT_UNAVAILABLE',
      503
    );
  }

  // Circuit breaker, before the upstream call — see lib/chat-quota.ts. This
  // route is the only one that presents the user-tier Fluxy credential and it
  // is reachable by every logged-in account, so an unbounded loop here is an
  // unbounded chat bill. Throws 429 rather than degrading.
  await assertChatMintQuota(c.env.DB, userId);

  const session = await mintChatSession(c.env, userId);

  // After the mint, deliberately: a FluxyChat outage should not spend a
  // founder's allowance on sessions they never received.
  await recordChatMint(c.env.DB, userId);

  return c.json(session);
});

export const chatWebhookRoutes = new Hono<{ Bindings: Env }>();

/**
 * The field is `tool_name`.
 *
 * This interface previously declared `name`, and the route read `body.name`, so
 * every callback fell through to the "Unknown tool: (none)" branch and the tool
 * webhook had never executed a single tool. The wire shape is not a guess:
 * FluxyChat's `executeToolCall` (apps/worker/src/lib/agent-tools.js) posts
 * `{ tool_name, arguments, tool_call_id, dry_run }`.
 *
 * `dry_run` is honoured for `escalate_to_human` because that tool sends mail to
 * a human; a rehearsal that pages the on-call is not a rehearsal.
 */
interface ToolExecuteBody {
  tool_name?: string;
  arguments?: unknown;
  dry_run?: boolean;
}

/**
 * Authenticates the callback and resolves who is asking.
 *
 * Two separate questions, deliberately answered in one place so no handler can
 * answer the first and forget the second — which is exactly the shape the old
 * IDOR had. `verifyWebhookKey` says the caller is FluxyChat;
 * `resolveChatToolToken` says which founder's room the call is for. Neither
 * substitutes for the other: the shared secret is the same on every call and
 * identifies no one.
 *
 * The token is read from the tool arguments, which the model writes — but it is
 * opaque, server-minted and bound to one room, so the only token the model can
 * relay is the one placed in its own [App Context]. That is the whole
 * difference from reading `user_id` from the same arguments.
 */
async function authenticateCallback(
  c: Context<{ Bindings: Env }>,
  args: Record<string, unknown>
): Promise<string> {
  if (!verifyWebhookKey(c.env, c.req.query('k'))) {
    throw new AuthError('Invalid FluxyChat webhook key');
  }
  const token =
    typeof args.session_token === 'string' ? args.session_token : null;
  const caller = await resolveChatToolToken(c.env.DB, token);
  if (!caller) {
    // Deliberately not "expired" versus "unknown" — see resolveChatToolToken.
    throw new AuthError('Invalid or expired chat session token');
  }
  return caller.userId;
}

// ============ GET /api/chat/webhook/context ============
/**
 * FluxyChat fetches this before each agent run and injects the result into the
 * model's messages as an `[App Context]` block. It is the only point in the
 * integration where caller identity is trustworthy: `userId` here comes from
 * FluxyChat's verified member JWT (`auth.userId`), minted by mintChatSession
 * for one specific Bicameral founder.
 *
 * So this endpoint's job is to convert that one trustworthy assertion into a
 * capability the tool webhook can check later, when identity is otherwise
 * absent.
 */
chatWebhookRoutes.get('/context', async (c) => {
  if (!verifyWebhookKey(c.env, c.req.query('k'))) {
    throw new AuthError('Invalid FluxyChat webhook key');
  }

  const userId = c.req.query('userId');
  const roomId = c.req.query('roomId');
  if (!userId || !roomId) {
    throw new ValidationError('userId and roomId are required');
  }

  // Support rooms are named `support-${userId}` by supportRoomId, so the pair
  // is checkable against itself. This is defence in depth rather than the
  // primary control — the key already proves the caller is FluxyChat — but it
  // means a future FluxyChat bug that crossed a room with the wrong member
  // fails closed here instead of minting a token for the wrong founder.
  if (roomId !== supportRoomId(userId)) {
    throw new AuthError('Room does not belong to this user');
  }

  const sessionToken = await mintChatToolToken(c.env.DB, { userId, roomId });

  // Only the token. The founder's pipeline state is deliberately NOT returned
  // here even though it would save a round trip: this payload is injected into
  // the model's context on every run, so anything added to it is disclosed to
  // the model whether or not the founder asked. get_pipeline_status stays a
  // tool call so that reading their data remains an act with a record.
  return c.json({ session_token: sessionToken });
});

// ============ POST /api/chat/webhook/tools/execute ============
chatWebhookRoutes.post('/tools/execute', async (c) => {
  const body = await c.req.json<ToolExecuteBody>();
  const args =
    typeof body.arguments === 'string'
      ? (JSON.parse(body.arguments) as Record<string, unknown>)
      : ((body.arguments ?? {}) as Record<string, unknown>);

  const userId = await authenticateCallback(c, args);

  if (body.tool_name === 'get_pipeline_status') {
    const result = await getPipelineStatusForUser(c.env.DB, userId);
    return c.json({ result });
  }

  if (body.tool_name === 'search_memory_lattice') {
    // `userId` is the one resolved from the capability token, never an
    // argument. `project_id` is allowed to narrow that set and can never widen
    // it — fetchLatticeContext joins projects on the user id unconditionally.
    const result = await fetchLatticeContext(c.env.DB, userId, {
      query: typeof args.query === 'string' ? args.query : '',
      projectId: typeof args.project_id === 'string' ? args.project_id : null,
    });
    return c.json({ result });
  }

  if (body.tool_name === 'escalate_to_human') {
    const reason = typeof args.reason === 'string' ? args.reason : 'general';
    const summary =
      typeof args.summary === 'string' ? args.summary : '(no summary given)';
    // A dry run must not email a human. FluxyChat sets this when rehearsing a
    // tool call, and an escalation is not idempotent from the recipient's side.
    if (body.dry_run) {
      return c.json({ result: { escalated: false, dryRun: true } });
    }
    const result = await escalateToHuman(c.env, userId, reason, summary);
    return c.json({ result });
  }

  throw new ValidationError(`Unknown tool: ${body.tool_name ?? '(none)'}`);
});

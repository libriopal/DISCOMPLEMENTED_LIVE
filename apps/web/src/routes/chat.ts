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
 * session — it authenticates the request with its own shared secret
 * instead (see lib/fluxychat.ts verifyToolWebhookSecret).
 */
import { Hono } from 'hono';
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
  verifyToolWebhookSecret,
  escalateToHuman,
} from '../lib/fluxychat.js';
import { assertChatMintQuota, recordChatMint } from '../lib/chat-quota.js';

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

interface ToolExecuteBody {
  name?: string;
  arguments?: unknown;
}

// ============ POST /api/chat/webhook/tools/execute ============
chatWebhookRoutes.post('/tools/execute', async (c) => {
  if (!verifyToolWebhookSecret(c.env, c.req.header('x-fluxy-api-key'))) {
    throw new AuthError('Invalid FluxyChat webhook secret');
  }

  const body = await c.req.json<ToolExecuteBody>();
  const args =
    typeof body.arguments === 'string'
      ? (JSON.parse(body.arguments) as Record<string, unknown>)
      : ((body.arguments ?? {}) as Record<string, unknown>);
  const userId = typeof args.user_id === 'string' ? args.user_id : null;
  if (!userId) throw new ValidationError('user_id is required');

  if (body.name === 'get_pipeline_status') {
    const result = await getPipelineStatusForUser(c.env.DB, userId);
    return c.json({ result });
  }

  if (body.name === 'escalate_to_human') {
    const reason = typeof args.reason === 'string' ? args.reason : 'general';
    const summary =
      typeof args.summary === 'string' ? args.summary : '(no summary given)';
    const result = await escalateToHuman(c.env, userId, reason, summary);
    return c.json({ result });
  }

  throw new ValidationError(`Unknown tool: ${body.name ?? '(none)'}`);
});

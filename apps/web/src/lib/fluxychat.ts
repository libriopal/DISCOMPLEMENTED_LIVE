/**
 * FluxyChat bridge — Phase 8. FluxyChat is a self-hosted chat Worker (its
 * own Cloudflare deployment, see @agent_docs/live-chat.md); this file talks
 * to it as a REST client via `@fluxy-chat/sdk` and answers the
 * pipeline-status tool its Cohere-backed support agent calls mid-run.
 */
import { FluxyChatClient, type FluxyChatToolDefinition } from '@fluxy-chat/sdk';
import { COHERE_MODELS } from '@bicameral/shared/constants';
import type { Env } from '../env.js';
import { timingSafeEqual } from './virtual-key.js';
import { sendEmail } from './email.js';
import { notifySlackBestEffort } from './slack.js';

export const SUPPORT_AGENT_HANDLE = 'support-ai';

const SUPPORT_ROOM_PREFIX = 'support-';

export function supportRoomId(userId: string): string {
  return `${SUPPORT_ROOM_PREFIX}${userId}`;
}

/**
 * The two Fluxy credentials, and why there are two.
 *
 * `FLUXYCHAT_API_KEY` is the admin/project key. It mints JWTs for ANY userId
 * with ANY roles, provisions the support agent, and is the shared secret that
 * authenticates FluxyChat's tool-execute callbacks. A holder of it can mint
 * themselves an admin token for another user's room. It is server-side only
 * and must never be reachable from a request a browser can make.
 *
 * `FLUXYCHAT_USER_API_KEY` is the user tier. It is what the public support
 * widget's session-mint path uses. It is still server-side — the browser never
 * sees either key, it sees the short-lived member JWT that comes back — but
 * keeping the mint path off the admin key means a defect in the public route
 * (a userId that is not validated, a roles array taken from the request body)
 * cannot escalate past what the user tier is allowed to issue.
 *
 * There is deliberately NO fallback from the user tier to the admin key. A
 * fallback would mean the separation silently stops existing the moment the
 * user key is unset, which is precisely when someone would be least likely to
 * notice.
 */
type FluxyTier = 'admin' | 'user';

function tierKey(env: Env, tier: FluxyTier): string | undefined {
  return tier === 'admin' ? env.FLUXYCHAT_API_KEY : env.FLUXYCHAT_USER_API_KEY;
}

function serverClient(
  env: Env,
  userId: string,
  tier: FluxyTier
): FluxyChatClient {
  return new FluxyChatClient({
    baseUrl: env.FLUXYCHAT_WORKER_URL,
    userId,
    apiKey: tierKey(env, tier),
  });
}

export interface ChatSession {
  token: string;
  userId: string;
  workerUrl: string;
  roomId: string;
  agentHandle: string;
}

/**
 * Mints a short-lived member JWT for the founder and makes sure their 1:1
 * support room exists (idempotent — createRoom 409s after the first call,
 * which we swallow). @fluxy-chat/sdk@0.2.2 (pinned — see package.json) has
 * no `client.signIn()` helper yet, so this mints the JWT with the same
 * `POST /auth/token` REST call the SDK's own README documents as the
 * "minimal backend" flow.
 */
export async function mintChatSession(
  env: Env,
  userId: string
): Promise<ChatSession> {
  // The user tier, never the admin key — see the note on serverClient. This
  // route is reachable by any logged-in user, so the credential it presents
  // upstream has to be the one whose blast radius is a member JWT.
  //
  // Unset is a refusal, not a degrade: without the key the request below would
  // send `X-Fluxy-Api-Key: undefined` and fail at FluxyChat with an opaque
  // auth error. Say which secret is missing instead.
  const apiKey = tierKey(env, 'user');
  if (!apiKey) {
    throw new Error(
      'FLUXYCHAT_USER_API_KEY is not set — live chat is unavailable. ' +
        'Set it with `wrangler secret put FLUXYCHAT_USER_API_KEY`. ' +
        'It is deliberately not the admin FLUXYCHAT_API_KEY: the user-facing ' +
        'mint path must not hold a credential that can mint admin roles.'
    );
  }

  const client = serverClient(env, userId, 'user');
  const roomId = supportRoomId(userId);

  const tokenRes = await fetch(`${env.FLUXYCHAT_WORKER_URL}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Fluxy-Api-Key': apiKey,
    },
    body: JSON.stringify({ userId, roles: ['member'], ttlSeconds: 3600 }),
  });
  if (!tokenRes.ok) {
    throw new Error(`FluxyChat token mint failed: ${tokenRes.status}`);
  }
  const { token } = await tokenRes.json<{ token: string }>();

  try {
    await client.createRoom({
      id: roomId,
      name: `Support — ${userId}`,
      type: 'direct',
      members: [{ userId, role: 'member' }],
    });
  } catch {
    // Already exists — expected on every session after the first.
  }

  return {
    token,
    userId,
    workerUrl: env.FLUXYCHAT_WORKER_URL,
    roomId,
    agentHandle: SUPPORT_AGENT_HANDLE,
  };
}

interface PipelineRunRow {
  id: string;
  project_id: string | null;
  status: string;
  current_step: number;
  current_agent: string | null;
  gate_status: string | null;
  error_message: string | null;
  updated_date: string;
}

interface PipelineStepRow {
  iteration: number;
  error_message: string | null;
}

export interface PipelineStatusSummary {
  active: boolean;
  pipelineRunId?: string;
  projectId?: string | null;
  step?: number;
  stepLabel?: string | null;
  agentRole?: string | null;
  status?: string;
  gateStatus?: string | null;
  iteration?: number | null;
  errorMessage?: string | null;
  updatedAt?: string;
}

// Mirrors routes/pipeline.ts TERMINAL_STATUSES — 'error' also covers
// founder/admin cancellation (see pipeline.ts POST /:id/cancel).
const ACTIVE_STATUS_EXCLUSION = "('deployed', 'error', 'paused')";

const STEP_LABELS: Record<number, string> = {
  1: 'Architect (Prompt Companion) — turning your vision into a project brief',
  2: 'Researcher (Research Discovered) — validating the tech stack',
  3: 'Designer (Design Coherent) — building the system blueprint',
  4: 'Coder (Architecture Implemented) — writing and deploying code',
};

/** Queried by the support agent's `get_pipeline_status` tool — see chatWebhookRoutes. */
export async function getPipelineStatusForUser(
  db: D1Database,
  userId: string
): Promise<PipelineStatusSummary> {
  const run = await db
    .prepare(
      `SELECT id, project_id, status, current_step, current_agent, gate_status, error_message, updated_date
       FROM pipeline_runs
       WHERE user_id = ? AND status NOT IN ${ACTIVE_STATUS_EXCLUSION}
       ORDER BY created_date DESC LIMIT 1`
    )
    .bind(userId)
    .first<PipelineRunRow>();

  if (!run) return { active: false };

  const step = await db
    .prepare(
      `SELECT iteration, error_message FROM pipeline_steps
       WHERE pipeline_run_id = ? ORDER BY step_number DESC, iteration DESC LIMIT 1`
    )
    .bind(run.id)
    .first<PipelineStepRow>();

  return {
    active: true,
    pipelineRunId: run.id,
    projectId: run.project_id,
    step: run.current_step,
    stepLabel: STEP_LABELS[run.current_step] ?? null,
    agentRole: run.current_agent,
    status: run.status,
    gateStatus: run.gate_status,
    iteration: step?.iteration ?? null,
    errorMessage: run.error_message ?? step?.error_message ?? null,
    updatedAt: run.updated_date,
  };
}

const SUPPORT_SYSTEM_PROMPT = `You are Bicameral's customer support assistant.
Be helpful, concise, and friendly.

You have access to the Bicameral pipeline system. When a founder asks about
their build status, call get_pipeline_status with their user_id. The
pipeline has 4 steps:
1. Architect (Prompt Companion) — turns vision into project brief
2. Researcher (Research Discovered) — validates tech stack
3. Designer (Design Coherent) — creates system blueprint
4. Coder (Architecture Implemented) — writes and deploys code

If a pipeline is awaiting_approval, tell the founder to review their
blueprint on the Design tab. If a pipeline failed, summarize the error and
offer to connect them with a human agent.

ESCALATION — do not try to resolve these yourself, even if you think you
know the answer. As soon as a message is about any of the following, call
escalate_to_human immediately with a short reason and summary, then tell
the founder a human will follow up by email:
- a security vulnerability, data breach, or account compromise report
- a billing dispute, unauthorized charge, refund request, or chargeback
- a legal notice, subpoena, DMCA claim, or ToS/privacy-policy dispute
- anything the founder explicitly asks to escalate to a human

If you cannot help with something else, say "Let me connect you with a
human agent" and call escalate_to_human with reason "general" — do not
just apologize and stop. Never make up information about pricing,
features, or account details.`;

const PIPELINE_STATUS_TOOL: FluxyChatToolDefinition = {
  type: 'function',
  function: {
    name: 'get_pipeline_status',
    description:
      "Get the status of the founder's active 4-agent pipeline run: which step it's on, iteration count, blueprint gate status, and any error.",
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: "The founder's Bicameral user id",
        },
      },
      required: ['user_id'],
    },
  },
};

const ESCALATION_REASONS = ['security', 'billing', 'legal', 'general'] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

const ESCALATE_TOOL: FluxyChatToolDefinition = {
  type: 'function',
  function: {
    name: 'escalate_to_human',
    description:
      'Flags this conversation for a human support agent to follow up by ' +
      'email instead of the AI trying to resolve it. Call this immediately ' +
      'for security, billing, or legal issues — do not attempt to resolve ' +
      'those yourself first.',
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: "The founder's Bicameral user id",
        },
        reason: {
          type: 'string',
          enum: [...ESCALATION_REASONS],
          description: 'Category of the issue',
        },
        summary: {
          type: 'string',
          description:
            "One or two sentences summarizing the founder's issue for the human agent.",
        },
      },
      required: ['user_id', 'reason', 'summary'],
    },
  },
};

/**
 * Handles the escalate_to_human tool call — emails a human agent (if
 * SUPPORT_ESCALATION_EMAIL is configured) with the founder's id and issue
 * summary. Never throws back into the chat flow: a founder reporting a
 * security issue should still get a "you're being connected" reply even if
 * the notification email itself fails, so failures are logged, not raised.
 */
export async function escalateToHuman(
  env: Env,
  userId: string,
  reason: string,
  summary: string
): Promise<{ escalated: boolean }> {
  const category = ESCALATION_REASONS.includes(reason as EscalationReason)
    ? reason
    : 'general';

  // No early return when the email is unconfigured. It used to return here,
  // which meant the one configuration where Slack is the ONLY notification
  // channel was the one configuration where Slack was never called. The email
  // block below is skipped instead, and the Slack send at the end still runs.
  if (!env.SUPPORT_ESCALATION_EMAIL) {
    console.error(
      `[chat escalation] ${category} — user ${userId}: ${summary} ` +
        `(SUPPORT_ESCALATION_EMAIL not configured, not emailed)`
    );
  } else {
    try {
      // summary/userId originate from an AI tool call driven by the
      // founder's own chat messages — escape before interpolating into HTML,
      // same as any other untrusted input reaching an email template.
      const esc = (s: string) =>
        s.replace(
          /[&<>"']/g,
          (c) =>
            ({
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;',
            })[c]!
        );
      await sendEmail(
        {
          to: env.SUPPORT_ESCALATION_EMAIL,
          subject: `[Bicameral support] ${category} escalation — ${userId}`,
          html: `
          <p><strong>Category:</strong> ${esc(category)}</p>
          <p><strong>Founder user id:</strong> ${esc(userId)}</p>
          <p><strong>Summary:</strong> ${esc(summary)}</p>
          <p>Room: ${esc(supportRoomId(userId))}</p>
        `.trim(),
        },
        env
      );
    } catch (err) {
      console.error(
        `[chat escalation] failed to send escalation email for user ${userId}:`,
        err
      );
    }
  }

  // Slack, after the email. Order is deliberate: the email is the record of
  // record (it reaches SUPPORT_ESCALATION_EMAIL, which is monitored), and
  // Slack is the thing that makes somebody look at it in minutes rather than
  // hours. If the email path above threw, it was already caught and logged —
  // and this still fires, because an escalation nobody was told about is the
  // worst outcome available here.
  await notifySlackBestEffort(
    env,
    {
      text: `:rotating_light: Support escalation — *${category}*`,
      fields: {
        User: userId,
        Room: supportRoomId(userId),
        Summary: summary,
        Emailed: env.SUPPORT_ESCALATION_EMAIL ?? 'not configured',
      },
    },
    `escalation for user ${userId}`
  );

  return { escalated: true };
}

/**
 * (Re)creates the Cohere-backed support agent on the FluxyChat Worker.
 * Idempotent by handle — safe to call from an admin route whenever the
 * system prompt or tool wiring changes. The Worker itself owns the Cohere
 * API key and llmBaseUrl for `provider: "custom"` (set via `wrangler secret
 * put` on the FluxyChat deployment, not passed through this call).
 */
export async function provisionSupportAgent(env: Env) {
  // USER tier, not admin — and this is a correction, not a preference.
  //
  // The tier split is two separate FluxyChat *projects* (FluxyChat has no
  // second key tier within one project; see the note on serverClient). A
  // FluxyChat agent belongs to the project it was created in, and so does a
  // room. mintChatSession creates every support room with the user-tier
  // client, so every room lives in the user-tier project. Provisioning the
  // agent with the admin key put it in the OTHER project, where it could
  // never see a single founder's message — the widget would connect, the
  // agent would exist, and nothing would ever answer.
  //
  // Using the user-tier key here is also strictly narrower, not wider: that
  // key is the project key for the project the agent belongs in. The admin
  // key stays unused on this path, which is the point of having two.
  if (!env.FLUXYCHAT_USER_API_KEY) {
    throw new Error(
      'FLUXYCHAT_USER_API_KEY is not set — cannot provision the support ' +
        'agent. Set it with `wrangler secret put FLUXYCHAT_USER_API_KEY`. ' +
        'It must be the user-tier project key, not FLUXYCHAT_API_KEY: the ' +
        'agent has to live in the same project as the support rooms.'
    );
  }

  const client = serverClient(env, 'system', 'user');
  return client.createAgent({
    name: 'Bicameral Support Assistant',
    handle: SUPPORT_AGENT_HANDLE,
    provider: 'custom',
    model: COHERE_MODELS.free,
    systemPrompt: SUPPORT_SYSTEM_PROMPT,
    toolExecuteUrl: `${env.APP_URL}/api/chat/webhook/tools/execute`,
    toolsSchema: [PIPELINE_STATUS_TOOL, ESCALATE_TOOL],
  });
}

/**
 * Accepts only the user-tier key. Accepting either key would make the admin
 * key a valid credential on a path whose entire purpose is to not need it,
 * and the agent lives in the user-tier project (see provisionSupportAgent).
 *
 * **This check currently rejects every real callback, and that is a known
 * defect, not a design.** An earlier version of this comment said FluxyChat
 * "signs outbound tool-execute callbacks with the project API key,
 * mirroring the inbound POST /auth/token convention". That was read off the
 * SDK README rather than off the sending code, and it is false. Measured
 * against FluxyChat's `executeToolCall` (apps/worker/src/lib/agent-tools.js):
 * the outbound request carries `Content-Type`, `X-Fluxy-Project-Id`,
 * `X-Fluxy-Tool-Name` and `X-Fluxy-Trace-Id` and nothing else, and
 * `safeOutboundFetch` passes init through without adding headers. Every
 * `X-Fluxy-Api-Key` in that codebase is a header it *reads*, never one it
 * sends.
 *
 * So there is no shared secret on this path to compare against, and the
 * webhook has never authenticated a single call. Switching this from the
 * admin key to the user key was still correct — it is strictly narrower —
 * but it did not make the path work and must not be read as having done so.
 * The real authentication mechanism is being designed in P1 §2 together with
 * the caller-identity problem, because the payload also carries no room or
 * member id to scope a request to. Do not "fix" this by accepting an
 * unauthenticated callback.
 */
export function verifyToolWebhookSecret(
  env: Env,
  header: string | undefined
): boolean {
  return (
    !!header &&
    !!env.FLUXYCHAT_USER_API_KEY &&
    timingSafeEqual(header, env.FLUXYCHAT_USER_API_KEY)
  );
}

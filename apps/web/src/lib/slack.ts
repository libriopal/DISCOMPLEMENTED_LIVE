/**
 * Slack notifications — operational alerts and support escalations.
 *
 * ## What this is for, and what it is not
 *
 * This is an *operator* channel. It carries things a human on our side needs
 * to see: a support escalation that has been raised, a nightly simulation
 * alert, a self-healing escalation that hit MAX_ATTEMPTS. It is not a user
 * surface and it is not a log sink — every send costs a Slack API call and a
 * notification on somebody's phone, so a message that nobody would act on
 * does not belong here.
 *
 * ## Why it fails soft, and why that is not the usual excuse
 *
 * `notifySlack` never throws. Everywhere it is called, it is the *second*
 * record of an event that is already recorded somewhere durable — the
 * escalation email, the `simulation_alerts` row, the console error. Letting a
 * Slack outage take down a support escalation would mean the notification
 * channel could break the thing it is notifying about.
 *
 * That argument only holds because the send is never the only record. It
 * returns a discriminated result rather than a boolean so a caller that
 * *does* need to know can, and so the reason is available to log: a silent
 * `false` here would make "the token is wrong" and "no channel configured"
 * look identical, and those need different fixes.
 *
 * ## Configuration
 *
 *   SLACK_BOT_TOKEN      secret, `xoxb-`. Needs `chat:write`.
 *   SLACK_ALERT_CHANNEL  var, a channel ID (`C…`). See the note below.
 *
 * The channel is an **ID**, not a `#name`. Resolving a name requires the
 * `channels:read` scope, which this bot deliberately does not have — reading
 * a workspace's channel list is a much broader grant than posting to one
 * channel, and the only thing it would buy is convenience in config. The bot
 * must also be a member of the channel: `/invite @bicameral` in Slack.
 * Without membership `chat.postMessage` answers `not_in_channel`, which is
 * surfaced verbatim rather than collapsed into "failed".
 */
import type { Env } from '../env.js';

const SLACK_POST_MESSAGE = 'https://slack.com/api/chat.postMessage';

/** Bounded so a Slack incident cannot hold a request open. */
const SLACK_TIMEOUT_MS = 5_000;

export type SlackResult =
  | { sent: true; ts: string }
  | { sent: false; reason: 'unconfigured'; detail: string }
  | { sent: false; reason: 'rejected'; detail: string }
  | { sent: false; reason: 'unreachable'; detail: string };

export interface SlackMessage {
  /** One line, shown in the notification and in the channel list. */
  text: string;
  /**
   * Optional labelled detail rendered as a context block. Values are passed
   * through Slack's mrkdwn escaping below — a summary here can contain text a
   * user typed.
   */
  fields?: Record<string, string>;
  /** Overrides SLACK_ALERT_CHANNEL for a message with its own destination. */
  channel?: string;
}

/**
 * Slack mrkdwn escaping, per the "Formatting text for app surfaces" doc:
 * only `&`, `<` and `>` are special, and they must be escaped in that order
 * so an escaped ampersand is not re-escaped.
 *
 * This matters because these messages carry user-authored text (a support
 * summary the founder typed). Unescaped `<...>` is parsed by Slack as a link
 * or, worse, as a `<!channel>` broadcast — a user could make our own alert
 * bot ping an entire workspace.
 */
export function escapeSlack(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function notifySlack(
  env: Env,
  message: SlackMessage
): Promise<SlackResult> {
  const token = env.SLACK_BOT_TOKEN;
  const channel = message.channel ?? env.SLACK_ALERT_CHANNEL;

  if (!token) {
    return {
      sent: false,
      reason: 'unconfigured',
      detail:
        'SLACK_BOT_TOKEN is not set. Provision it with ' +
        '`wrangler secret put SLACK_BOT_TOKEN`.',
    };
  }
  if (!channel) {
    return {
      sent: false,
      reason: 'unconfigured',
      detail:
        'SLACK_ALERT_CHANNEL is not set. It is a channel ID (starts with "C"), ' +
        'not a #name — this bot has no channels:read scope to resolve names.',
    };
  }

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: escapeSlack(message.text) },
    },
  ];
  if (message.fields && Object.keys(message.fields).length > 0) {
    blocks.push({
      type: 'context',
      elements: Object.entries(message.fields).map(([k, v]) => ({
        type: 'mrkdwn',
        text: `*${escapeSlack(k)}:* ${escapeSlack(v)}`,
      })),
    });
  }

  let response: Response;
  try {
    response = await fetch(SLACK_POST_MESSAGE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      // `text` is sent alongside `blocks` deliberately: Slack uses it as the
      // notification/fallback text, and a blocks-only message shows as "This
      // content can't be displayed" in a push notification.
      body: JSON.stringify({
        channel,
        text: escapeSlack(message.text),
        blocks,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      sent: false,
      reason: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Slack answers 200 with `{ok: false, error: "..."}` for application-level
  // failures — an expired token, a channel the bot was removed from. Checking
  // `response.ok` alone reports every one of those as a success, which is the
  // failure mode that makes an alerting channel silently stop alerting.
  const body = await response
    .json<{ ok?: boolean; error?: string; ts?: string }>()
    .catch(() => null);

  if (!body?.ok) {
    return {
      sent: false,
      reason: 'rejected',
      detail: body?.error ?? `HTTP ${response.status}`,
    };
  }

  return { sent: true, ts: body.ts ?? '' };
}

/**
 * Send, and log rather than throw when it does not land.
 *
 * The shape every caller wants: Slack is the second record, so a failure is
 * worth a line in the Worker log and nothing more. Named separately from
 * `notifySlack` so that "I chose to ignore the result" is visible at the call
 * site instead of being an untracked floating promise.
 */
export async function notifySlackBestEffort(
  env: Env,
  message: SlackMessage,
  context: string
): Promise<SlackResult> {
  const result = await notifySlack(env, message);
  if (!result.sent) {
    console.error(
      `[slack] ${context}: not delivered (${result.reason}) — ${result.detail}`
    );
  }
  return result;
}

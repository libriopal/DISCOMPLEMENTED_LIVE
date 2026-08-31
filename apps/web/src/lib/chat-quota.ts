/**
 * Circuit breaker for the user-tier live-chat path.
 *
 * `POST /api/chat/token` is the only route that presents
 * FLUXYCHAT_USER_API_KEY upstream. It is reachable by every logged-in
 * account, and each call hands the browser a credential that can then talk to
 * an LLM-backed agent on our budget. Without a cap, one account (or one stolen
 * session) can open sessions in a loop and drain the chat budget.
 *
 * Two windows, not one. A single daily cap allows the entire day's allowance
 * to be spent in the first ten seconds; a single hourly cap allows 24x the
 * intended daily volume. The pair bounds both the burst and the total.
 *
 * WHAT THIS DOES NOT DO — this is the important limitation and it is not a
 * TODO, it is a boundary. This bounds how many chat *sessions* an account can
 * open. It does not bound token spend. Once the member JWT is in the browser,
 * messages go straight from the browser to the FluxyChat Worker; this Worker
 * is not on that path and cannot count a single token of it. The token
 * ceiling has to be enforced where the spend happens, by FluxyChat's own
 * per-project monthly `agent_invoke_limit_monthly` on the user-tier project
 * (see docs/fluxychat-provisioning.md). Treat the two as one control with two
 * halves: this half bounds fan-out, that half bounds spend.
 */
import { RateLimitError } from '@bicameral/shared/errors';

/**
 * Mints per rolling hour, per user. mintChatSession asks FluxyChat for a JWT
 * with ttlSeconds: 3600, so a widget that stays open needs one mint per hour.
 * 12 leaves room for reloads, several tabs, and a flaky connection, and still
 * refuses a loop.
 */
export const CHAT_MINTS_PER_HOUR = 12;

/**
 * Mints per rolling 24 hours, per user. 60 is five hours of continuous
 * worst-case legitimate use — far past any real support conversation, and two
 * orders of magnitude below what an unattended loop would reach.
 */
export const CHAT_MINTS_PER_DAY = 60;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long mint rows are kept. Must exceed the widest window above, or the
 * prune would delete rows the daily cap still needs to count. 48h is that
 * window doubled, so a prune that is late by a day is still not wrong.
 */
export const CHAT_MINT_RETENTION_MS = 48 * HOUR_MS;

export interface ChatMintQuotaState {
  lastHour: number;
  lastDay: number;
}

async function countSince(
  db: D1Database,
  userId: string,
  sinceMs: number
): Promise<number> {
  const since = new Date(sinceMs).toISOString();
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS count FROM chat_session_mints WHERE user_id = ? AND created_date >= ?'
    )
    .bind(userId, since)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Throws RateLimitError (429) when the user is over either window. Call BEFORE
 * minting: the point is to not spend the upstream call.
 */
export async function assertChatMintQuota(
  db: D1Database,
  userId: string,
  now = Date.now()
): Promise<ChatMintQuotaState> {
  // Sequential, and the hour first, because the hour is the window a runaway
  // client trips within seconds — the common case should cost one query.
  const lastHour = await countSince(db, userId, now - HOUR_MS);
  if (lastHour >= CHAT_MINTS_PER_HOUR) {
    throw new RateLimitError(
      `Live chat session limit reached (${CHAT_MINTS_PER_HOUR}/hour). Try again shortly.`
    );
  }

  const lastDay = await countSince(db, userId, now - DAY_MS);
  if (lastDay >= CHAT_MINTS_PER_DAY) {
    throw new RateLimitError(
      `Live chat session limit reached (${CHAT_MINTS_PER_DAY}/day). Try again tomorrow, or email support.`
    );
  }

  return { lastHour, lastDay };
}

/**
 * Records a successful mint. Called AFTER the upstream mint succeeds, so a
 * FluxyChat outage does not burn a user's allowance on sessions they never
 * got — the failure mode of recording first is a user locked out of support
 * by the very outage they want to report.
 *
 * The trade this accepts: a caller who can make the upstream mint fail
 * repeatedly is not counted. That is bounded anyway, because a failing mint
 * hands out no credential and so spends no chat budget.
 */
export async function recordChatMint(
  db: D1Database,
  userId: string,
  now = Date.now()
): Promise<void> {
  // toISOString(), never SQLite's datetime('now'): the latter renders
  // "2026-08-31 10:00:00" — space separator, no Z — and countSince compares
  // this column lexicographically against a toISOString() bound. 'T' sorts
  // after ' ', so space-formatted rows would fall below every bound and the
  // count would read 0 forever. See migrations/028_chat_session_mints.sql.
  await db
    .prepare(
      'INSERT INTO chat_session_mints (id, user_id, created_date) VALUES (?, ?, ?)'
    )
    .bind(crypto.randomUUID(), userId, new Date(now).toISOString())
    .run();
}

/**
 * Deletes mint rows older than the retention window. Called from the daily
 * cron. Returns the number of rows removed.
 */
export async function pruneChatMints(
  db: D1Database,
  now = Date.now()
): Promise<number> {
  const cutoff = new Date(now - CHAT_MINT_RETENTION_MS).toISOString();
  const result = await db
    .prepare('DELETE FROM chat_session_mints WHERE created_date < ?')
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}

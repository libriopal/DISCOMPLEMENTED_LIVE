/**
 * Capability tokens that give the FluxyChat tool webhook a caller identity.
 *
 * Read migrations/029_chat_tool_tokens.sql first — it records the measurement
 * this design rests on. In short: the tool-execute callback carries no member
 * identity, so the route used to take `user_id` from the tool arguments, which
 * the model writes. The context-fetch callback DOES carry a verified userId, so
 * a token minted there and relayed by the agent replaces a model-authored
 * assertion of identity with a model-relayed opaque capability. The model can
 * still lie about the token's value; it just cannot produce one that resolves
 * to a founder other than the one whose room it is in.
 */
import { sha256Hex } from './virtual-key.js';

/**
 * Deliberately shorter than the hour-long member JWT. The token only has to
 * survive a single conversation's tool calls, and the room it belongs to can
 * always mint a fresh one on the next context fetch — FluxyChat performs that
 * fetch per agent run, caching it for 60s of its own accord.
 */
export const CHAT_TOOL_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface ChatToolCaller {
  userId: string;
  roomId: string;
}

/**
 * 256 bits from the CSPRNG, hex encoded. Not a UUID: v4 carries six fixed bits
 * and is generated for uniqueness rather than unguessability, and this value is
 * a bearer credential.
 */
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mints a token for a caller FluxyChat has already authenticated. Returns the
 * raw token — the only time it exists in this Worker — and stores only its
 * hash.
 */
export async function mintChatToolToken(
  db: D1Database,
  caller: ChatToolCaller,
  now = Date.now()
): Promise<string> {
  const token = newToken();
  await db
    .prepare(
      `INSERT INTO chat_tool_tokens (token_hash, user_id, room_id, created_date, expires_date)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      await sha256Hex(token),
      caller.userId,
      caller.roomId,
      new Date(now).toISOString(),
      new Date(now + CHAT_TOOL_TOKEN_TTL_MS).toISOString()
    )
    .run();
  return token;
}

/**
 * Resolves a token to its caller, or null.
 *
 * Null covers every failure — absent, malformed, unknown, expired — on purpose.
 * The webhook's answer to all of them is the same 401, and distinguishing
 * "expired" from "never existed" in a response tells an attacker which guesses
 * were once real tokens.
 *
 * Expiry is enforced in the WHERE clause rather than by trusting the sweep, so
 * a stalled cron cannot silently extend every token's life.
 */
export async function resolveChatToolToken(
  db: D1Database,
  token: string | null | undefined,
  now = Date.now()
): Promise<ChatToolCaller | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = await db
    .prepare(
      `SELECT user_id, room_id FROM chat_tool_tokens
       WHERE token_hash = ? AND expires_date > ?`
    )
    .bind(await sha256Hex(token), new Date(now).toISOString())
    .first<{ user_id: string; room_id: string }>();
  return row ? { userId: row.user_id, roomId: row.room_id } : null;
}

/** Deletes expired tokens. Called from the daily cron. */
export async function pruneChatToolTokens(
  db: D1Database,
  now = Date.now()
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM chat_tool_tokens WHERE expires_date <= ?')
    .bind(new Date(now).toISOString())
    .run();
  return result.meta.changes ?? 0;
}

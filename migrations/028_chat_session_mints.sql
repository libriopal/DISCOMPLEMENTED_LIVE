-- Circuit breaker for the user-tier FluxyChat mint path
-- (routes/chat.ts POST /api/chat/token → lib/chat-quota.ts).
--
-- One row per member-JWT mint. The row exists so the cap can be counted over
-- a *sliding* window: a KV counter with a fixed hourly bucket lets a caller
-- spend a full window at 10:59 and another at 11:00, which is twice the cap
-- in two seconds — precisely the burst this is meant to stop. Counting rows
-- since `now - window` has no seam.
--
-- D1 rather than KV for the same reason the research quota uses D1: KV reads
-- are eventually consistent, and a rate limit whose counter can read stale is
-- a rate limit that can be beaten by making the requests fast enough. This
-- table is small (bounded by the caps themselves times the user count) and
-- pruned by the daily cron.
--
-- What this table can and cannot bound, stated plainly: it bounds how many
-- chat sessions an account can open. It does NOT bound LLM token spend — the
-- spend happens inside the FluxyChat Worker after the JWT has been handed to
-- the browser, where this Worker is no longer on the path. That ceiling is
-- enforced at the real boundary, by FluxyChat's own per-project
-- `agent_invoke_limit_monthly` on the user-tier project. Both layers are
-- required; neither substitutes for the other.
--
-- Written idempotently, like every migration here.

CREATE TABLE IF NOT EXISTS chat_session_mints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- ISO-8601 UTC with the T separator and trailing Z — i.e. exactly what
  -- `new Date().toISOString()` produces, which is the convention every other
  -- created_date in this schema is written with (see routes/research.ts).
  --
  -- Deliberately NO `DEFAULT (datetime('now'))`. SQLite's datetime() renders
  -- "2026-08-31 10:00:00" with a space and no Z, and the quota query compares
  -- this column lexicographically against a toISOString() bound. 'T' (0x54)
  -- sorts after ' ' (0x20), so a space-formatted row is less than EVERY
  -- T-formatted bound: the count would come back 0 forever and the cap would
  -- never fire. A missing default makes a wrong-format insert impossible to
  -- write by accident, because there is nothing to fall back to.
  created_date TEXT NOT NULL
);

-- The quota query is always "count rows for THIS user since THIS timestamp",
-- so the index leads with user_id and carries created_date as the second
-- column. Leading with created_date instead would make every check scan every
-- user's mints in the window.
CREATE INDEX IF NOT EXISTS idx_chat_session_mints_user_date
  ON chat_session_mints(user_id, created_date);

-- Supports the cron's prune, which is date-only and crosses all users.
CREATE INDEX IF NOT EXISTS idx_chat_session_mints_date
  ON chat_session_mints(created_date);

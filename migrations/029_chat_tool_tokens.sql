-- Capability tokens for the FluxyChat tool webhook.
--
-- The problem this solves: FluxyChat's outbound tool-execute callback carries
-- no member identity and no shared secret. Measured against its own
-- executeToolCall (apps/worker/src/lib/agent-tools.js), the request body is
-- { tool_name, arguments, tool_call_id, dry_run } and the headers are
-- Content-Type, X-Fluxy-Project-Id, X-Fluxy-Tool-Name and X-Fluxy-Trace-Id.
-- Nothing in it says which founder is asking. The route therefore used to read
-- user_id out of the tool arguments — which the MODEL composes, making any
-- user_id it can be induced to emit an authorised read of another founder's
-- pipeline.
--
-- The context-fetch callback is different and is what makes a fix possible: it
-- receives projectId, roomId and userId as query parameters, and that userId
-- comes from `auth.userId` — FluxyChat's verified member JWT, minted by
-- mintChatSession for one specific Bicameral user. So identity is trustworthy
-- at context-fetch time and absent at tool-execute time, and this table is the
-- bridge between the two: mint a random capability token during the context
-- fetch, hand it to the agent inside its [App Context] block, and resolve the
-- caller from the token when the tool fires.
--
-- Only the SHA-256 of the token is stored. The row is a verifier, not a
-- credential store: a D1 read must not yield anything that can be replayed
-- against this webhook. Same reasoning as users.virtual_key.
--
-- What this does NOT claim: the token reaches the model's context, so a
-- founder who induces the agent to print it learns their own token. That buys
-- nothing — it authorises exactly the access they already have. It is not a
-- defence against a user attacking their own session, and it is not one
-- against FluxyChat itself, which mints the identity. It closes the
-- cross-tenant hole, which is the one that mattered.
CREATE TABLE IF NOT EXISTS chat_tool_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  room_id     TEXT NOT NULL,
  -- ISO 8601 via toISOString(), never SQLite's datetime('now'). Every
  -- comparison against these columns is lexicographic against a JS-generated
  -- bound, and datetime('now') renders "2026-08-31 06:18:23" — space
  -- separator, no zone — which sorts BELOW every such bound on the same day.
  -- migrations/028 and apps/web/src/routes/pipeline.ts carry the same note;
  -- it has already caused two live defects in this repo.
  created_date TEXT NOT NULL,
  expires_date TEXT NOT NULL
);

-- Expiry sweeps delete by date across all users, so the index is on the date
-- alone. Lookup is by primary key and needs no index of its own.
CREATE INDEX IF NOT EXISTS idx_chat_tool_tokens_expires
  ON chat_tool_tokens (expires_date);

-- Per-user display settings, starting with pipeline verboseness (§3.3).
--
-- A row per user rather than a column on `users`: `users` is the account
-- record — tier, credits, ban state, admin level — and every one of its
-- columns is something the platform decides about a person. A display
-- preference is something the person decides about the platform, and mixing
-- the two means every future preference is a migration against the table that
-- authorisation reads.
--
-- `verboseness` is deliberately an unconstrained TEXT column with a default,
-- matching `pipeline_runs.execution_mode`, and it carries the same obligation:
-- read it through `normalizeVerboseness` (lib/verboseness.ts), never a cast.
-- D1 does not enforce CHECK constraints retroactively and a value written by
-- an older build, a hand-run UPDATE, or a client sending something unexpected
-- must resolve to a defined level rather than to a level with no promise
-- attached. `execution_mode` learned this the expensive way — see the note on
-- `dangerously_automated` in CLAUDE.md.
--
-- Written idempotently, like every migration in this directory: the
-- production ledger records only 001, so the first --remote run will offer
-- this file against a database that may already have it.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  verboseness TEXT NOT NULL DEFAULT 'normal',
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

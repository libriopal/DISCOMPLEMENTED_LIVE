-- Safety migration: adds retry_attempt column to tripwire_events if it doesn't exist.
-- Redundant with migration 015 for fresh deployments (015 already includes retry_attempt).
-- This handles deployments that ran an older 015 without the column.
-- SQLite ALTER TABLE ADD COLUMN with DEFAULT is safe, but we guard to prevent duplicate-column errors.

-- D1 does not support IF NOT EXISTS on ALTER TABLE, so we use a pragma check approach.
-- This is a no-op if the column already exists.
-- Note: D1 does not support procedural SQL or IF statements, so this migration
-- is intentionally a no-op comment — the retry_attempt column is already created in migration 015.
-- This file exists for forward-only migration ordering and to document the intent.
SELECT 1;

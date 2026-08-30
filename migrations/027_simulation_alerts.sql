-- Alerts raised by the nightly simulation watchdog (§3.5 item 6).
--
-- Separate from `simulation_runs` because an alert is not a property of a
-- run: the loudest one — "the nightly has stopped reporting" — has no run to
-- hang off, and that is exactly the alert a column on `simulation_runs` could
-- never store. It is also separate from `security_events`, which is the
-- audit trail of things people and attackers did; a simulation finding is an
-- observation about the system, and filing it there would make the security
-- log answer a question it was not asked.
--
-- `dedupe_key` is UNIQUE and is what makes the watchdog idempotent. The cron
-- runs daily and reads the same two rows until a new report lands, so without
-- it every alert would be re-raised every morning until someone fixed it —
-- which trains the reader to ignore the table. Keys are `<run_id>:<kind>`
-- for a finding about a run, and `no_run:<YYYY-MM-DD>` for the absence of
-- one, so a dead nightly says so once a day rather than once per cron tick
-- and rather than only once ever.
--
-- Nothing reads this table to change behaviour. It is written by the cron and
-- read by the admin surface, and the auto-apply boundary in
-- 018_simulation_runs.sql covers it in full.
--
-- Written idempotently, like every migration here: the production ledger
-- records only 001, so the first --remote run will offer this file against a
-- database that may already have it.
CREATE TABLE IF NOT EXISTS simulation_alerts (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  acknowledged_by TEXT,
  acknowledged_date TEXT,
  created_date TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_simulation_alerts_dedupe
  ON simulation_alerts(dedupe_key);

-- The admin surface reads newest-first and filters to unacknowledged.
CREATE INDEX IF NOT EXISTS idx_simulation_alerts_created
  ON simulation_alerts(created_date DESC);

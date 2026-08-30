-- 006_rate_limit_race_fix.sql — fixes a validated rate-limit bypass found
-- during a local pentest pass: checkRateLimit() (lib/virtual-key.ts) did a
-- check-then-act SELECT followed by an INSERT-if-missing / UPDATE-if-found,
-- with only a non-unique index on (virtual_key, window_start). Under
-- concurrency, every simultaneous request read "no row yet" and inserted
-- its own row, so N concurrent requests got N independent counters instead
-- of sharing one. Repro: 80 concurrent requests against a 50/hour free-tier
-- virtual key all returned 200.
--
-- A UNIQUE index lets the fixed code use `INSERT ... ON CONFLICT DO NOTHING`
-- to safely establish exactly one row per window even under a concurrent
-- first-request race, followed by the same atomic WHERE-guarded UPDATE
-- pattern debitCredits() already uses for credit balances.
--
-- Defensive dedup first: collapse any duplicate (virtual_key, window_start)
-- rows that may already exist (e.g. from local testing) into one, keeping
-- the highest request_count, before the unique index can be created.
DELETE FROM rate_limit_windows
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY virtual_key, window_start
      ORDER BY request_count DESC, id
    ) AS rn
    FROM rate_limit_windows
  ) WHERE rn = 1
);

DROP INDEX IF EXISTS idx_rate_limit_key_window;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limit_key_window_unique
  ON rate_limit_windows(virtual_key, window_start);

-- The monthly grant was being paid daily.
--
-- `handleDailyCreditReset` runs on cron "0 3 * * *" — every morning — and set
-- credits_remaining to the MONTHLY grant. Nothing recorded when a grant was
-- last issued, so there was nothing to make the payment happen once a month
-- rather than once a day.
--
-- A Pro subscriber who spent their refill each morning drew 30 x 1,000 =
-- 30,000 credits a month: 1,200 apps, $342 of delivery cost against $29 of
-- revenue. Before the pricing fix it was 30 x 50,000. Either way the grant was
-- never the ceiling it was described as, and pricing-solvency.test.ts could not
-- see it: every test there reasons about TIER_LIMITS, and this defect lives in
-- the SCHEDULE, which no test read.
--
-- Found by the independent §4B audit, one commit after the same audit caught
-- the grant figures themselves being paid from stale literals. Same root shape
-- both times: the number was right and the thing that pays it was not.
--
-- The guard is a stored timestamp rather than a monthly cron, deliberately.
-- Moving the schedule to "0 3 1 * *" would make a MISSED run cost a subscriber
-- their whole month, and a DOUBLE run (retry, manual invocation, a second
-- deployment) pay twice with nothing to stop it. A recorded last-granted date
-- makes the payment idempotent: it happens on the first run of a calendar
-- month and any number of later runs that month are no-ops.
--
-- NULL means "never granted", which is correct for every existing row: the
-- first run after this migration issues one grant, then records the date.

ALTER TABLE users ADD COLUMN credits_granted_at TEXT;

-- Answering "who is due a grant?" is the whole job of the monthly reset, and
-- it runs against every user row. Without this it is a full scan every day.
CREATE INDEX IF NOT EXISTS idx_users_credits_granted_at
  ON users(credits_granted_at);

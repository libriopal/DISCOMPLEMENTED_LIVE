-- The free signup grant was 20x what the free tier is priced to give away.
--
-- `001_init.sql` set `credits_remaining INTEGER DEFAULT 1000`, and because new
-- accounts are created through better-auth's adapter rather than an INSERT in
-- this repo, that default IS the signup grant. At 25 credits per generation and
-- $0.285 all-in per delivered app, 1,000 credits is 40 apps and $11.40 of real
-- delivery cost per free signup, with no card attached.
--
-- TIER_LIMITS.free.creditsPerMonth is 50, sized deliberately as an acquisition
-- cost (2 apps, $0.57). The constant was cut when pricing was re-derived from
-- measured cost; this DEFAULT was not, because it lives in SQL and nothing read
-- both. pricing-solvency.test.ts asserted "the free tier costs less to serve
-- than a cup of coffee" against the constant — true of the constant, false of
-- every account the product actually created.
--
-- Found by the independent §4B audit on the commit that claimed to have fixed
-- the revenue. The same commit left the monthly cron paying the old pro, team
-- and enterprise grants from hardcoded literals; that is fixed in
-- cron-handler.ts, which now builds its SQL from TIER_LIMITS so the payout and
-- the number the tests read cannot drift apart again.
--
-- SQLite cannot ALTER a column default, so the table is rebuilt. THE COLUMN
-- LIST IS NOT COPIED FROM 001_init.sql: `users` has been altered twice since
-- (002 added email_verified and avatar_url, 005 added stripe_customer_id and
-- an index on it), so a rebuild from the original CREATE would silently drop
-- three columns including the Stripe customer linkage. The 17 columns below
-- were read back from a database with migrations 001-027 actually applied,
-- via PRAGMA table_info, and `schema-drift.test.ts` re-derives that comparison
-- on every run so this cannot rot.

PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user',
  tier TEXT DEFAULT 'free',
  virtual_key TEXT UNIQUE,
  admin_level TEXT,
  credits_remaining INTEGER DEFAULT 50,
  credits_used INTEGER DEFAULT 0,
  is_banned INTEGER DEFAULT 0,
  trial_expires_at TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT,
  email_verified INTEGER DEFAULT 0,
  avatar_url TEXT,
  stripe_customer_id TEXT
);

-- EXISTING BALANCES ARE CARRIED OVER UNCHANGED, DELIBERATELY.
--
-- Every column is copied as-is, credits_remaining included. Clawing back
-- credits that existing free accounts were already granted is a decision about
-- real people's balances, not a schema fix, and not one a migration should make
-- on its own while nobody is looking. The new default binds new signups; the
-- balances already issued stand until someone decides otherwise and says so.
INSERT INTO users_new (
  id, email, full_name, role, tier, virtual_key, admin_level,
  credits_remaining, credits_used, is_banned, trial_expires_at,
  created_date, updated_date, created_by,
  email_verified, avatar_url, stripe_customer_id
)
SELECT
  id, email, full_name, role, tier, virtual_key, admin_level,
  credits_remaining, credits_used, is_banned, trial_expires_at,
  created_date, updated_date, created_by,
  email_verified, avatar_url, stripe_customer_id
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Recreated because DROP TABLE took it with the old table. Dropping an index
-- is invisible until a Stripe webhook does a full scan under load.
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id
  ON users(stripe_customer_id);

PRAGMA foreign_keys = ON;

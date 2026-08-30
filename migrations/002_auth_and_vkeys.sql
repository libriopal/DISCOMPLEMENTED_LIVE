-- 002_auth_and_vkeys.sql — Better Auth tables + Virtual Key Proxy
-- Extends the `users` table (001_init.sql) with the columns Better Auth's
-- `user` model needs, and adds sessions/accounts/verifications (Better Auth
-- model names, mapped in apps/web/src/lib/auth.ts) plus the rate-limit
-- ledger for the Virtual Key Proxy. See @agent_docs/security.md.

ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- Better Auth: sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- Better Auth: accounts (OAuth provider links — GitHub)
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_account ON accounts(provider_id, account_id);

-- Better Auth: verifications (email verification / OAuth state tokens)
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier);

-- Virtual Key Proxy: sliding-window rate limit tracking, per key per route.
-- One row per (virtual_key, window_start) bucket; count is incremented
-- atomically and swept by the daily cron (see wrangler.toml [triggers]).
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  id TEXT PRIMARY KEY,
  virtual_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  request_count INTEGER DEFAULT 0,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_key_window ON rate_limit_windows(virtual_key, window_start);

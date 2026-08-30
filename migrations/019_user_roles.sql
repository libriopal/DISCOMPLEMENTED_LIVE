-- P0.1: User roles in separate table (never a column on users)
CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'user')),
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);

-- Stripe event idempotency (P0.4)
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events(type);

-- Admin audit log with IP/UA (P0.1)
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user TEXT,
  target_project TEXT,
  reason TEXT,
  ip TEXT,
  ua TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON admin_audit_log(created_at DESC);

-- Credit ledger (P0.2)
-- REMOVED: this migration used to re-declare `credit_ledger`. The table is
-- owned by 001_init.sql. The redeclaration named a different shape
-- (`created_at`, `reference`, a CHECK on `type`) but was guarded by
-- IF NOT EXISTS, so it silently did nothing — 001 always runs first — and the
-- index that followed then referenced `created_at`, a column the live table
-- does not have, failing with `no such column: created_at`.
--
-- That abort is why everything after this point in the file (approval_gates,
-- audit_results, verification_results) never applied on a fresh database, and
-- is what broke `pnpm test:integration`. The redeclaration is removed rather
-- than reconciled; reshaping credit_ledger, if still wanted, belongs in its
-- own forward migration with an explicit ALTER.
--
-- 001_init.sql already indexes user_id (idx_credit_ledger_user_id); the
-- timestamp column there is `created_date`, indexed below.
CREATE INDEX IF NOT EXISTS idx_credit_ledger_created ON credit_ledger(created_date DESC);

-- Approval gates (P0.5)
CREATE TABLE IF NOT EXISTS approval_gates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('L1', 'L2', 'L3', 'L4', 'L5')),
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  reviewer_id TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approval_gates_project ON approval_gates(project_id);
CREATE INDEX IF NOT EXISTS idx_approval_gates_level ON approval_gates(level);

-- Audit results (P1)
CREATE TABLE IF NOT EXISTS audit_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  score REAL NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  issues TEXT,
  recommendations TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_results_project ON audit_results(project_id);

-- Verification results (P1)
CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  evidence_score REAL NOT NULL,
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  verified_artifacts TEXT,
  failed_artifacts TEXT,
  gaps TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_verification_results_project ON verification_results(project_id);

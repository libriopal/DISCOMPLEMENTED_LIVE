CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pipeline_run_id TEXT,
  feature TEXT NOT NULL,
  agent_step TEXT,
  credits REAL NOT NULL,
  burn_rate REAL,
  budget_remaining REAL,
  idempotency_key TEXT NOT NULL,
  created_date TEXT NOT NULL,
  UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_cost_events_user ON cost_events(user_id, created_date);

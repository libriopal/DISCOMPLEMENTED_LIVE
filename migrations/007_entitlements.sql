CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  feature TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('allow','deny','degrade')),
  reason TEXT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('admin','system','tripwire')),
  actor_id TEXT,
  expires_at TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  UNIQUE(user_id, feature)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_expires ON entitlements(expires_at);

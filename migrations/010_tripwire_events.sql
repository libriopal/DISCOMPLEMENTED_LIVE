CREATE TABLE IF NOT EXISTS tripwire_events (
  id TEXT PRIMARY KEY,
  tripwire TEXT NOT NULL,
  user_id TEXT,
  pipeline_run_id TEXT,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
  condition_detail TEXT NOT NULL,
  condition_hash TEXT NOT NULL,
  remedy TEXT NOT NULL CHECK(remedy IN ('pause','refund','alert','block','notify','auto_grant','escalate')),
  remedy_status TEXT NOT NULL DEFAULT 'pending' CHECK(remedy_status IN ('pending','applied','failed','skipped')),
  remedy_idempotency_key TEXT,
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  actor_type TEXT DEFAULT 'system',
  created_date TEXT NOT NULL,
  resolved_date TEXT,
  UNIQUE(condition_hash),
  UNIQUE(remedy_idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_tripwire_events_user ON tripwire_events(user_id);
CREATE INDEX IF NOT EXISTS idx_tripwire_events_status ON tripwire_events(remedy_status);
CREATE INDEX IF NOT EXISTS idx_tripwire_events_created ON tripwire_events(created_date);

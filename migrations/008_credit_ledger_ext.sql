CREATE TABLE IF NOT EXISTS credit_ledger_ext (
  id TEXT PRIMARY KEY,
  credit_ledger_id TEXT NOT NULL REFERENCES credit_ledger(id),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('provisional','confirmed','revoked')),
  pipeline_run_id TEXT,
  source_entry_id TEXT,
  idempotency_key TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK(actor_type IN ('user','admin','system','tripwire','verifier','cron')),
  actor_id TEXT,
  created_date TEXT NOT NULL,
  UNIQUE(idempotency_key),
  UNIQUE(credit_ledger_id)
);
CREATE INDEX IF NOT EXISTS idx_cle_status ON credit_ledger_ext(status, pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_cle_source ON credit_ledger_ext(source_entry_id);

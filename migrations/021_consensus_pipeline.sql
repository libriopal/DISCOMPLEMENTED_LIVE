-- Migration 021: 5-Agent Consensus Pipeline
-- Adds: agent_messages table (group chat), execution_mode + gate columns

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  step TEXT NOT NULL,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  created_date TEXT NOT NULL,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(pipeline_run_id, created_at);

ALTER TABLE pipeline_runs ADD COLUMN execution_mode TEXT DEFAULT 'ask_first';
ALTER TABLE pipeline_runs ADD COLUMN current_gate TEXT;
ALTER TABLE pipeline_runs ADD COLUMN audit_result TEXT;
ALTER TABLE pipeline_runs ADD COLUMN verification_result TEXT;

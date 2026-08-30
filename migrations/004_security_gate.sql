-- Security gate (Task 2, GitHub-Actions-backed) — see
-- agent_docs and bicameral_security-gate-coder-loop memory. Replaces the
-- Sandbox-container-based scan (pipeline/tools/security-scan.ts), which
-- depends on Cloudflare Containers/Workers Paid — not available under the
-- account's current budget (see bicameral_zero-budget-constraint memory).
-- Semgrep now runs as a GitHub Actions job dispatched by the Coder step;
-- these columns/table let the pipeline pause for that out-of-process scan
-- and resume via a webhook callback instead of blocking a Worker request.

ALTER TABLE pipeline_runs ADD COLUMN security_retry_count INTEGER DEFAULT 0;
ALTER TABLE pipeline_runs ADD COLUMN pending_security_errors TEXT;

CREATE TABLE IF NOT EXISTS security_gate_runs (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | error
  findings TEXT,
  error_message TEXT,
  -- Coder's result for this scan, stashed so the webhook callback can
  -- finalize (write `generations`, mark the run deployed) without
  -- re-invoking the DO when the scan comes back clean.
  files TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_date TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_security_gate_runs_run_id ON security_gate_runs(pipeline_run_id);

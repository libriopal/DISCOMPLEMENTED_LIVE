-- Monte Carlo simulation run results. Purely informational — the app
-- NEVER reads this table to change its own behavior automatically.
-- A human (admin) must review findings and explicitly approve any
-- architecture change before it is implemented as a separate commit.
CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL DEFAULT 'monte_carlo', -- monte_carlo | live_bot_test
  status TEXT NOT NULL DEFAULT 'completed',     -- running | completed | failed
  num_bots INTEGER NOT NULL,
  total_credits_simulated INTEGER NOT NULL DEFAULT 0,
  vdr_percent REAL,
  house_edge_percent REAL,
  exploits_found_json TEXT,       -- JSON array of exploit findings
  tripwire_breakdown_json TEXT,   -- JSON object of tripwire -> count
  recommendations_json TEXT,      -- JSON array of hardening recommendations
  raw_report_json TEXT,           -- full report for drill-down
  approved_by_admin INTEGER NOT NULL DEFAULT 0,  -- 0 = pending review, 1 = admin reviewed
  applied_to_architecture INTEGER NOT NULL DEFAULT 0, -- 0 = not applied, 1 = applied (manual, separate commit)
  created_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_simulation_runs_created ON simulation_runs(created_date DESC);

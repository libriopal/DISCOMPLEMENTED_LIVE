-- Lattice Executions table for GLAAS-Lattice tracking
-- From Butterfly v5 evolved architecture
CREATE TABLE IF NOT EXISTS lattice_executions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  vdr REAL NOT NULL DEFAULT 0.0,
  zero_waste_score REAL NOT NULL DEFAULT 0.0,
  gap_detection_score REAL NOT NULL DEFAULT 0.0,
  total_credits INTEGER NOT NULL DEFAULT 0,
  value_credits INTEGER NOT NULL DEFAULT 0,
  waste_credits INTEGER NOT NULL DEFAULT 0,
  research_fitness REAL DEFAULT 0.0,
  audit_fitness REAL DEFAULT 0.0,
  design_fitness REAL DEFAULT 0.0,
  code_fitness REAL DEFAULT 0.0,
  verify_fitness REAL DEFAULT 0.0,
  prompt_style TEXT DEFAULT 'socratic',
  island_context TEXT DEFAULT 'startup',
  artifacts TEXT, -- JSON array of artifact paths
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_lattice_user ON lattice_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_lattice_status ON lattice_executions(status);
CREATE INDEX IF NOT EXISTS idx_lattice_vdr ON lattice_executions(vdr DESC);

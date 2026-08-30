CREATE TABLE IF NOT EXISTS preference_matrix (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  accept_count INTEGER DEFAULT 0,
  reject_count INTEGER DEFAULT 0,
  updated_date TEXT NOT NULL,
  UNIQUE(project_id, feature)
);

CREATE TABLE IF NOT EXISTS preference_corrections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  correction_text TEXT NOT NULL,
  embedding TEXT,
  embedding_model TEXT NOT NULL DEFAULT 'embed-v4.0',
  source_pipeline_run_id TEXT,
  created_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pref_corrections_project ON preference_corrections(project_id, created_date);

CREATE TABLE IF NOT EXISTS project_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  cluster_size INTEGER NOT NULL,
  rule_hash TEXT NOT NULL,
  created_date TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  UNIQUE(project_id, rule_hash)
);
CREATE INDEX IF NOT EXISTS idx_project_rules_project ON project_rules(project_id);

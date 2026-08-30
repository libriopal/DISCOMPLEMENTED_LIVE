CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  pipeline_run_id TEXT,
  thesis TEXT NOT NULL,
  antithesis TEXT NOT NULL,
  axis_label TEXT NOT NULL,
  chosen TEXT NOT NULL CHECK(chosen IN ('thesis','antithesis')),
  rationale TEXT,
  thesis_embedding TEXT,
  antithesis_embedding TEXT,
  embedding_model TEXT NOT NULL DEFAULT 'embed-v4.0',
  user_position REAL DEFAULT 0.5 CHECK(user_position >= 0 AND user_position <= 1),
  created_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);

CREATE TABLE IF NOT EXISTS decision_axes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  axis_vector TEXT NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT 'embed-v4.0',
  created_date TEXT NOT NULL,
  UNIQUE(project_id, label)
);

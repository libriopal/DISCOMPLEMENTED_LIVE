-- 001_init.sql — Bicameral D1 Schema (11 tables)
-- 7 core + 3 pipeline + 1 admin
-- See agent_docs/database-schema.md for full spec

-- 1. users (no dependencies)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user',
  tier TEXT DEFAULT 'free',
  virtual_key TEXT UNIQUE,
  admin_level TEXT,
  credits_remaining INTEGER DEFAULT 1000,
  credits_used INTEGER DEFAULT 0,
  is_banned INTEGER DEFAULT 0,
  trial_expires_at TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);

-- 2. projects (depends on users)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  files TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

-- 3. pipeline_runs (depends on users, projects)
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  current_step INTEGER DEFAULT 0,
  current_agent TEXT,
  brief TEXT,
  research TEXT,
  blueprint_id TEXT,
  deployment_url TEXT,
  error_message TEXT,
  gate_status TEXT,
  gate_feedback TEXT,
  total_credits_used INTEGER DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user_id ON pipeline_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_id ON pipeline_runs(project_id);

-- 4. pipeline_steps (depends on pipeline_runs)
CREATE TABLE IF NOT EXISTS pipeline_steps (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  agent_role TEXT NOT NULL,
  model_used TEXT NOT NULL,
  input TEXT,
  output TEXT,
  status TEXT DEFAULT 'pending',
  iteration INTEGER DEFAULT 1,
  error_message TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  credits_used INTEGER DEFAULT 0,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_date TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run_id ON pipeline_steps(pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_step_number ON pipeline_steps(step_number);

-- 5. blueprints (depends on pipeline_runs)
CREATE TABLE IF NOT EXISTS blueprints (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  components TEXT NOT NULL,
  database_schema TEXT,
  api_routes TEXT,
  auth_strategy TEXT,
  env_vars TEXT,
  deploy_config TEXT,
  approved INTEGER DEFAULT 0,
  founder_feedback TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_blueprints_pipeline_run_id ON blueprints(pipeline_run_id);

-- 6. generations (depends on projects, users, pipeline_runs)
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  user_id TEXT NOT NULL,
  pipeline_run_id TEXT,
  prompt TEXT NOT NULL,
  model_used TEXT NOT NULL,
  files TEXT,
  status TEXT DEFAULT 'pending',
  credits_used INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_generations_user_id ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_generations_project_id ON generations(project_id);
CREATE INDEX IF NOT EXISTS idx_generations_pipeline_run_id ON generations(pipeline_run_id);

-- 7. lattice_nodes (depends on projects)
CREATE TABLE IF NOT EXISTS lattice_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  embedding_id TEXT,
  metadata TEXT,
  x REAL,
  y REAL,
  z REAL,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_lattice_nodes_project_id ON lattice_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_lattice_nodes_type ON lattice_nodes(type);

-- 8. lattice_edges (depends on lattice_nodes)
CREATE TABLE IF NOT EXISTS lattice_edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  type TEXT DEFAULT 'reference',
  created_date TEXT NOT NULL,
  FOREIGN KEY (source_node_id) REFERENCES lattice_nodes(id),
  FOREIGN KEY (target_node_id) REFERENCES lattice_nodes(id)
);

-- 9. research_queries (depends on users, projects, pipeline_runs)
CREATE TABLE IF NOT EXISTS research_queries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  pipeline_run_id TEXT,
  query TEXT NOT NULL,
  results TEXT,
  model_used TEXT DEFAULT 'rerank-v4.0',
  credits_used INTEGER DEFAULT 5,
  created_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_user_id ON research_queries(user_id);
CREATE INDEX IF NOT EXISTS idx_research_pipeline_run_id ON research_queries(pipeline_run_id);

-- 10. credit_ledger (depends on users, pipeline_runs)
CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  pipeline_run_id TEXT,
  created_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_pipeline_run_id ON credit_ledger(pipeline_run_id);

-- 11. security_events (admin panel)
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  ip_address TEXT,
  user_id TEXT,
  route TEXT,
  details TEXT,
  created_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_created_date ON security_events(created_date);

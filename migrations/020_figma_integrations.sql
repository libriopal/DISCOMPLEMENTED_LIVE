-- Figma OAuth integration — stores access tokens for users who connect their Figma account
-- Used to import design files as references for the prompt-to-app pipeline.

CREATE TABLE IF NOT EXISTS figma_integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  figma_user_id TEXT,
  figma_user_name TEXT,
  figma_user_handle TEXT,
  figma_email TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TEXT,
  scopes TEXT,
  created_date TEXT NOT NULL DEFAULT (datetime('now')),
  updated_date TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_figma_user ON figma_integrations(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_figma_user_id ON figma_integrations(figma_user_id) WHERE figma_user_id IS NOT NULL;

-- Store cached Figma file references that users have imported
CREATE TABLE IF NOT EXISTS figma_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  figma_file_key TEXT NOT NULL,
  figma_file_name TEXT,
  figma_file_url TEXT,
  node_id TEXT,
  import_metadata TEXT, -- JSON blob with layer info, components, styles
  pipeline_run_id TEXT, -- Links to the pipeline run that used this import
  created_date TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_figma_imports_user ON figma_imports(user_id);
CREATE INDEX IF NOT EXISTS idx_figma_imports_file ON figma_imports(figma_file_key);

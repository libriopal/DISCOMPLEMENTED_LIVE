-- Health Scores table for NS3 proactive detection
-- P3 FIX: unique(user_id) + upsert pattern (was append-only with no unique key)
CREATE TABLE IF NOT EXISTS health_scores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  overall_score REAL NOT NULL DEFAULT 1.0,
  engagement_score REAL NOT NULL DEFAULT 1.0,
  feature_adoption_score REAL NOT NULL DEFAULT 1.0,
  support_sentiment_score REAL NOT NULL DEFAULT 1.0,
  payment_health_score REAL NOT NULL DEFAULT 1.0,
  vdr_score REAL NOT NULL DEFAULT 1.0,
  risk_level TEXT NOT NULL DEFAULT 'healthy' CHECK (risk_level IN ('healthy', 'at-risk', 'critical')),
  detected_issues TEXT,
  recommended_actions TEXT,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- P3: unique constraint on user_id for upsert (ON CONFLICT(user_id) DO UPDATE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_scores_user_unique ON health_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_health_scores_risk ON health_scores(risk_level);
CREATE INDEX IF NOT EXISTS idx_health_scores_updated ON health_scores(last_updated DESC);

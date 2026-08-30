CREATE TABLE IF NOT EXISTS dunning_workflow (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  stripe_invoice_id TEXT,
  decline_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  next_retry_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','recovered','exhausted','cancelled')),
  grace_period_end TEXT NOT NULL,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  UNIQUE(stripe_subscription_id, stripe_invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_dunning_next_retry ON dunning_workflow(next_retry_at);

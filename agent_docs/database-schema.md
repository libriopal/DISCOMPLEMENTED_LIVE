# Database Schema — Bicameral D1

> Referenced by CLAUDE.md via `@agent_docs/database-schema.md`. Read before Phase 2.

## 7 Core Tables + 3 Pipeline Tables + 1 Admin Table + 4 Auth/Rate-Limit Tables + 1 Security Gate Table + 2 Billing Tables = 18 total

The 11 tables below (users through security_events) shipped in `001_init.sql`. Four more (`sessions`, `accounts`, `verifications`, `rate_limit_windows`) were added by `002_auth_and_vkeys.sql` for Better Auth + the Virtual Key Proxy, plus two `ALTER TABLE users` columns. `003_lattice_node_content.sql` adds one column to `lattice_nodes` (no new table). `004_security_gate.sql` adds `security_gate_runs` plus two `ALTER TABLE pipeline_runs` columns. `005_billing.sql` adds `subscriptions` and `stripe_webhook_events` plus one `ALTER TABLE users` column (`stripe_customer_id`). See the new tables and migration order below the original 11.

### users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user',           -- 'user' | 'admin'
  tier TEXT DEFAULT 'free',          -- 'free' | 'pro' | 'team' | 'enterprise'
  virtual_key TEXT UNIQUE,            -- UUID v4
  admin_level TEXT,                   -- NULL | 'read' | 'write' | 'full'
  credits_remaining INTEGER DEFAULT 1000,
  credits_used INTEGER DEFAULT 0,
  is_banned INTEGER DEFAULT 0,
  trial_expires_at TEXT,             -- ISO date, NULL if not trial
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
```

`002_auth_and_vkeys.sql` later adds `email_verified INTEGER DEFAULT 0` and `avatar_url TEXT` to this table (Better Auth's `user.fields` mapping — see `04-infra-bindings-auth.md` in `vault/bootstrap/` if present, or `apps/web/src/lib/auth.ts`).

### projects

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',      -- 'active' | 'archived' | 'deleted'
  files TEXT,                         -- JSON: [{ path, content }]
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX idx_projects_user_id ON projects(user_id);
```

### generations

```sql
CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  user_id TEXT NOT NULL,
  pipeline_run_id TEXT,              -- FK to pipeline_runs (NULL for legacy direct generations)
  prompt TEXT NOT NULL,
  model_used TEXT NOT NULL,          -- 'north-mini-code' | 'command-r7b-12-2024' | 'command-a'
  files TEXT,                         -- JSON: [{ path, content }]
  status TEXT DEFAULT 'pending',     -- 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled'
  credits_used INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX idx_generations_user_id ON generations(user_id);
CREATE INDEX idx_generations_project_id ON generations(project_id);
CREATE INDEX idx_generations_pipeline_run_id ON generations(pipeline_run_id);
```

### lattice_nodes

```sql
CREATE TABLE lattice_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,                 -- 'semantic' | 'implementation' | 'bridge'
  label TEXT NOT NULL,
  embedding_id TEXT,                  -- Vectorize vector ID
  metadata TEXT,                      -- JSON: { file_path, line_range, description, pipeline_step, agent_role }
  x REAL,                             -- UMAP projection X
  y REAL,                             -- UMAP projection Y
  z REAL,                             -- UMAP projection Z
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX idx_lattice_nodes_project_id ON lattice_nodes(project_id);
CREATE INDEX idx_lattice_nodes_type ON lattice_nodes(type);
```

### lattice_edges

```sql
CREATE TABLE lattice_edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  type TEXT DEFAULT 'reference',     -- 'reference' | 'depends_on' | 'implements' | 'bridges'
  created_date TEXT NOT NULL,
  FOREIGN KEY (source_node_id) REFERENCES lattice_nodes(id),
  FOREIGN KEY (target_node_id) REFERENCES lattice_nodes(id)
);
```

### research_queries

```sql
CREATE TABLE research_queries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  pipeline_run_id TEXT,              -- FK to pipeline_runs (NULL for standalone research)
  query TEXT NOT NULL,
  results TEXT,                       -- JSON: [{ title, content, score }]
  model_used TEXT DEFAULT 'rerank-v4.0',
  credits_used INTEGER DEFAULT 5,
  created_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX idx_research_user_id ON research_queries(user_id);
CREATE INDEX idx_research_pipeline_run_id ON research_queries(pipeline_run_id);
```

### credit_ledger

```sql
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,            -- positive = credit, negative = debit
  type TEXT NOT NULL,                 -- 'debit' | 'credit' | 'trial' | 'admin_adjustment'
  description TEXT,
  pipeline_run_id TEXT,              -- FK to pipeline_runs (NULL for non-pipeline transactions)
  created_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX idx_credit_ledger_user_id ON credit_ledger(user_id);
CREATE INDEX idx_credit_ledger_pipeline_run_id ON credit_ledger(pipeline_run_id);
```

### pipeline_runs (NEW — 4-agent pipeline tracking)

```sql
CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  prompt TEXT NOT NULL,               -- Original founder vision text
  status TEXT DEFAULT 'pending',     -- 'pending' | 'ideating' | 'researching' | 'designing' | 'awaiting_approval' | 'implementing' | 'deployed' | 'error' | 'cancelled'
  current_step INTEGER DEFAULT 0,   -- 0=pending, 1=architect, 2=researcher, 3=designer, 4=coder
  current_agent TEXT,                -- 'architect' | 'researcher' | 'designer' | 'coder'
  brief TEXT,                         -- JSON: Agent 1 output (ProjectBrief)
  research TEXT,                      -- JSON: Agent 2 output (ResearchFindings)
  blueprint_id TEXT,                  -- FK to blueprints table (Agent 3 output)
  deployment_url TEXT,               -- Final deployed URL (Agent 4 output)
  error_message TEXT,                -- NULL if successful, error details if failed
  gate_status TEXT,                  -- NULL | 'pending' | 'approved' | 'rejected' | 'timeout'
  gate_feedback TEXT,                -- Founder's feedback if rejected (triggers restart)
  total_credits_used INTEGER DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX idx_pipeline_runs_user_id ON pipeline_runs(user_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX idx_pipeline_runs_project_id ON pipeline_runs(project_id);
```

### pipeline_steps (NEW — individual agent execution records)

```sql
CREATE TABLE pipeline_steps (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,      -- 1=architect, 2=researcher, 3=designer, 4=coder
  agent_role TEXT NOT NULL,          -- 'architect' | 'researcher' | 'designer' | 'coder'
  model_used TEXT NOT NULL,          -- 'command-a' | 'command-r7b-12-2024' | 'north-mini-code'
  input TEXT,                        -- JSON: input to the agent (brief, research, blueprint, etc.)
  output TEXT,                        -- JSON: agent's structured output
  status TEXT DEFAULT 'pending',     -- 'pending' | 'running' | 'complete' | 'error' | 'skipped'
  iteration INTEGER DEFAULT 1,       -- For Coder: which error-feedback iteration (1-5)
  error_message TEXT,               -- NULL if successful
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  credits_used INTEGER DEFAULT 0,
  duration_ms INTEGER,              -- Wall time for this step
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_date TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);
CREATE INDEX idx_pipeline_steps_run_id ON pipeline_steps(pipeline_run_id);
CREATE INDEX idx_pipeline_steps_step_number ON pipeline_steps(step_number);
```

### blueprints (NEW — Agent 3 output stored for founder review + Coder input)

```sql
CREATE TABLE blueprints (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  version INTEGER DEFAULT 1,         -- Incremented if founder requests redesign
  components TEXT NOT NULL,          -- JSON: [{ path, type, description, dependencies }]
  database_schema TEXT,              -- JSON: { tables, relationships }
  api_routes TEXT,                    -- JSON: [{ method, path, handler, request, response }]
  auth_strategy TEXT,                -- 'none' | 'github' | 'email' | 'api_key'
  env_vars TEXT,                      -- JSON: [{ name, description, required }]
  deploy_config TEXT,                -- JSON: { runtime, buildCommand, outputDir }
  approved INTEGER DEFAULT 0,       -- 0=pending, 1=approved, -1=rejected
  founder_feedback TEXT,            -- NULL or founder's modification request
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);
CREATE INDEX idx_blueprints_pipeline_run_id ON blueprints(pipeline_run_id);
```

### security_events (admin panel — Phase 7)

```sql
CREATE TABLE security_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,           -- 'auth_failed' | 'waf_block' | 'sqli_attempt' | 'xss_attempt' | 'rate_limit_hit' | 'pipeline_abuse'
  severity TEXT NOT NULL,             -- 'low' | 'medium' | 'high' | 'critical'
  ip_address TEXT,
  user_id TEXT,
  route TEXT,
  details TEXT,                       -- JSON
  created_date TEXT NOT NULL
);
CREATE INDEX idx_security_events_severity ON security_events(severity);
CREATE INDEX idx_security_events_created_date ON security_events(created_date);
```

## Auth + Rate-Limit Tables (002_auth_and_vkeys.sql — NEW)

### sessions (Better Auth)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token);
```

### accounts (Better Auth — OAuth provider links, e.g. GitHub)

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_accounts_user_id ON accounts(user_id);
CREATE UNIQUE INDEX idx_accounts_provider_account ON accounts(provider_id, account_id);
```

### verifications (Better Auth — email verification / OAuth state tokens)

```sql
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL
);
CREATE INDEX idx_verifications_identifier ON verifications(identifier);
```

### rate_limit_windows (Virtual Key Proxy — sliding-window rate limiting)

```sql
CREATE TABLE rate_limit_windows (
  id TEXT PRIMARY KEY,
  virtual_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  request_count INTEGER DEFAULT 0,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL
);
CREATE INDEX idx_rate_limit_key_window ON rate_limit_windows(virtual_key, window_start);
```

One row per `(virtual_key, window_start)` hour-bucket, backing `virtual-key.ts`'s `checkRateLimit()`. Swept by the daily 3am UTC cron in `wrangler.toml`'s `[triggers]`.

## Lattice Content Column (003_lattice_node_content.sql — NEW, no new table)

`ALTER TABLE lattice_nodes ADD COLUMN content TEXT;` — stores the actual ingested text (not just a label) so `findSimilarPatterns()` can inject real prior context into agent prompts, instead of just a title.

## Security Gate Table (004_security_gate.sql — NEW)

### security_gate_runs

```sql
CREATE TABLE security_gate_runs (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'error'
  findings TEXT,
  error_message TEXT,
  files TEXT NOT NULL,                    -- Coder's result, stashed for the webhook callback
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_date TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);
CREATE INDEX idx_security_gate_runs_run_id ON security_gate_runs(pipeline_run_id);
```

Tracks the async GitHub-Actions Semgrep scan dispatched after the Coder loop succeeds. Stashes the Coder's `files`/`model`/token totals so the webhook callback (`routes/security-gate-webhook.ts`) can finalize the run directly from D1 without re-invoking the DO when the scan is clean. Replaces an earlier Sandbox-container-based scan (`pipeline/tools/security-scan.ts`, still present but superseded by `security-scan-gh.ts`) because Cloudflare Containers requires Workers Paid, which isn't provisioned.

Also adds two columns to `pipeline_runs`: `security_retry_count INTEGER DEFAULT 0` and `pending_security_errors TEXT`, capping Coder↔security-gate retry cycles separately from `PIPELINE_DEFAULTS.maxCoderIterations`.

## Billing Tables (005_billing.sql — NEW)

Also adds one column to `users`: `stripe_customer_id TEXT` (nullable — set lazily on first checkout or portal visit, not at signup).

### subscriptions

```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'active' | 'past_due' | 'canceled' (mirrors Stripe subscription.status)
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  current_period_end TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE UNIQUE INDEX idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);
```

Backs the tier-subscription checkout flow (`routes/billing.ts` `POST /api/billing/checkout/subscription`) — one row per Stripe subscription, updated by the `customer.subscription.updated`/`.deleted` webhook events. One-time credit-pack purchases don't get a row here; they're fully captured by `credit_ledger` (`type = 'credit'`).

### stripe_webhook_events

```sql
CREATE TABLE stripe_webhook_events (
  id TEXT PRIMARY KEY,      -- Stripe event id (evt_...), not a generated uuid
  event_type TEXT NOT NULL,
  processed_date TEXT NOT NULL
);
```

Idempotency dedup for `POST /api/billing/webhook` — Stripe retries a delivery on any non-2xx response and can occasionally redeliver even after a prior 200, so the handler checks this table before applying any credit/tier change and inserts into it after.

## Migration Order

1. users (no dependencies)
2. projects (depends on users)
3. pipeline_runs (depends on users, projects) — **NEW**
4. pipeline_steps (depends on pipeline_runs) — **NEW**
5. blueprints (depends on pipeline_runs) — **NEW**
6. generations (depends on projects, users, pipeline_runs)
7. lattice_nodes (depends on projects)
8. lattice_edges (depends on lattice_nodes)
9. research_queries (depends on users, projects, pipeline_runs)
10. credit_ledger (depends on users, pipeline_runs)
11. security_events (no dependencies — admin only)
12. sessions (depends on users) — **NEW, 002**
13. accounts (depends on users) — **NEW, 002**
14. verifications (no dependencies) — **NEW, 002**
15. rate_limit_windows (no dependencies) — **NEW, 002**
16. lattice_nodes.content column added — **003** (not a new table)
17. security_gate_runs (depends on pipeline_runs) — **NEW, 004**
18. users.stripe_customer_id column added — **005** (not a new table)
19. subscriptions (depends on users) — **NEW, 005**
20. stripe_webhook_events (no dependencies) — **NEW, 005**

## Indexes Summary

| Table              | Index                                  | Column(s)                 |
| ------------------ | -------------------------------------- | ------------------------- |
| projects           | idx_projects_user_id                   | user_id                   |
| generations        | idx_generations_user_id                | user_id                   |
| generations        | idx_generations_project_id             | project_id                |
| generations        | idx_generations_pipeline_run_id        | pipeline_run_id           |
| lattice_nodes      | idx_lattice_nodes_project_id           | project_id                |
| lattice_nodes      | idx_lattice_nodes_type                 | type                      |
| research_queries   | idx_research_user_id                   | user_id                   |
| research_queries   | idx_research_pipeline_run_id           | pipeline_run_id           |
| credit_ledger      | idx_credit_ledger_user_id              | user_id                   |
| credit_ledger      | idx_credit_ledger_pipeline_run_id      | pipeline_run_id           |
| pipeline_runs      | idx_pipeline_runs_user_id              | user_id                   |
| pipeline_runs      | idx_pipeline_runs_status               | status                    |
| pipeline_runs      | idx_pipeline_runs_project_id           | project_id                |
| pipeline_steps     | idx_pipeline_steps_run_id              | pipeline_run_id           |
| pipeline_steps     | idx_pipeline_steps_step_number         | step_number               |
| blueprints         | idx_blueprints_pipeline_run_id         | pipeline_run_id           |
| security_events    | idx_security_events_severity           | severity                  |
| security_events    | idx_security_events_created_date       | created_date              |
| sessions           | idx_sessions_user_id                   | user_id                   |
| sessions           | idx_sessions_token                     | token                     |
| accounts           | idx_accounts_user_id                   | user_id                   |
| accounts           | idx_accounts_provider_account (unique) | provider_id, account_id   |
| verifications      | idx_verifications_identifier           | identifier                |
| rate_limit_windows | idx_rate_limit_key_window              | virtual_key, window_start |
| security_gate_runs | idx_security_gate_runs_run_id          | pipeline_run_id           |

## Pipeline Data Flow

```
Founder prompt
    ↓
pipeline_runs row created (status: 'pending')
    ↓
Step 1 (Architect):
    pipeline_steps row (step_number: 1, agent_role: 'architect')
    pipeline_runs.brief = JSON output
    pipeline_runs.status = 'ideating' → 'researching'
    ↓
Step 2 (Researcher):
    pipeline_steps row (step_number: 2, agent_role: 'researcher')
    pipeline_runs.research = JSON output
    research_queries row (linked to pipeline_run_id)
    pipeline_runs.status = 'researching' → 'designing'
    ↓
Step 3 (Designer):
    pipeline_steps row (step_number: 3, agent_role: 'designer')
    blueprints row created (components, schema, routes, deploy config)
    pipeline_runs.blueprint_id = blueprint.id
    pipeline_runs.status = 'designing' → 'awaiting_approval'
    pipeline_runs.gate_status = 'pending'
    ↓
HUMAN GATE: Founder reviews blueprint
    pipeline_runs.gate_status = 'approved' (proceed) or 'rejected' (restart with feedback)
    ↓
Step 4 (Coder):
    pipeline_steps rows (step_number: 4, agent_role: 'coder', iteration: 1-5)
    generations row (linked to pipeline_run_id, files = generated code)
    pipeline_runs.status = 'implementing' → 'deployed'
    pipeline_runs.deployment_url = preview URL
    ↓
Credit ledger: all token costs tracked per pipeline_run_id
Lattice nodes: research findings + blueprint patterns + error fixes embedded
```

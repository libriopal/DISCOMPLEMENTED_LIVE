# D1 Migrations

All migrations target **Cloudflare D1** (SQLite dialect). They use `TEXT` for IDs, `datetime('now')` for timestamps, and integer booleans (0/1).

## Execution Order

Migrations MUST be applied in numerical order. Each migration assumes all prior migrations have run.

| #   | File                          | Creates                                                                                                                                                 |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | 001_init.sql                  | users, projects, pipeline_runs, pipeline_steps, blueprints, generations, lattice_nodes, lattice_edges, research_queries, credit_ledger, security_events |
| 002 | 002_auth_and_vkeys.sql        | sessions, accounts, verifications, rate_limit_windows                                                                                                   |
| 003 | 003_lattice_node_content.sql  | (column additions to lattice_nodes)                                                                                                                     |
| 004 | 004_security_gate.sql         | security_gate_runs                                                                                                                                      |
| 005 | 005_billing.sql               | subscriptions, stripe_webhook_events                                                                                                                    |
| 006 | 006_rate_limit_race_fix.sql   | (rate limit race fix)                                                                                                                                   |
| 007 | 007_entitlements.sql          | entitlements                                                                                                                                            |
| 008 | 008_credit_ledger_ext.sql     | credit_ledger_ext                                                                                                                                       |
| 009 | 009_health_scores.sql         | health_scores (unique user_id, upsert)                                                                                                                  |
| 010 | 010_tripwire_events.sql       | tripwire_events                                                                                                                                         |
| 011 | 011_decisions.sql             | decisions, decision_axes                                                                                                                                |
| 012 | 012_lattice_executions.sql    | lattice_executions                                                                                                                                      |
| 013 | 013_cost_events.sql           | cost_events                                                                                                                                             |
| 014 | 014_dunning_workflow.sql      | dunning_workflow                                                                                                                                        |
| 015 | 015_preference_matrix.sql     | preference_matrix, preference_corrections, project_rules                                                                                                |
| 016 | 016_eicca.sql                 | eicca_contracts, eicca_credits, eicca_repayments                                                                                                        |
| 017 | 017_tripwire_retry_column.sql | (column addition to tripwire_events)                                                                                                                    |
| 018 | 018_simulation_runs.sql       | simulation_runs                                                                                                                                         |
| 019 | 019_user_roles.sql            | user_roles, admin_audit_log, approval_gates, audit_results, verification_results                                                                        |

## Apply All Migrations

```bash
# From repo root — applies all migrations in order to remote D1
for f in migrations/*.sql; do wrangler d1 execute bicameral --file="$f" --remote; done

# Or individual:
wrangler d1 execute bicameral --file=migrations/001_init.sql --remote
```

## Guard

Before applying migration N, verify migrations 1..N-1 have been applied:

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

If any expected table is missing, STOP — do not apply out of order.

## Missing Migrations 007-012 (original numbering)

The original repo had gaps at migrations 007-012. The D1 database contains tables from those migrations (autonomy_action_effects, autonomy_audit_log, autonomy_checkpoints, autonomy_tombstones, autonomy_usage, pipeline_events, audit_log) but the migration files were never committed. These tables already exist in production D1 and do not need to be re-created.

The renumbering (v2 audit fix) compresses the sequence to 001-019 with no gaps.

## Target Database

**Cloudflare D1 (SQLite dialect).** These migrations will NOT run on PostgreSQL/Supabase without adaptation. If migrating to Postgres:

- Replace `TEXT PRIMARY KEY` with `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- Replace `datetime('now')` with `NOW()`
- Replace `INTEGER ... CHECK (x IN (0,1))` with `BOOLEAN`
- Replace `INSERT OR IGNORE` with `INSERT ... ON CONFLICT DO NOTHING`
- Add explicit `GRANT`s alongside RLS policies

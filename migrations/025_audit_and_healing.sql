-- Independent-auditor findings (§4A/§4B) and self-healing loop history (§4C).
--
-- Why not `audit_results`. That table exists (019) and the brief points at it,
-- but its shape belongs to something else: it is project-scoped
-- (`project_id NOT NULL`), keyed on a single `score REAL NOT NULL`, and written
-- only by the admin package's governance auditor. Neither thing recorded here
-- has a project or a score. A §4B audit is scoped to a commit in this
-- repository, not to a user's project, and a §4C attempt is scoped to a failing
-- gate. Forcing either into `audit_results` would mean inventing a project id
-- and a number, which is how a table stops meaning anything. It keeps its job;
-- these are new.
--
-- Both tables are written to be queryable as evidence, not just as a log. The
-- point of persisting §4C attempts is that "the loop needed three tries" is a
-- measurable statement about the codebase, and it cannot be measured if the
-- attempts only ever existed in a terminal.

-- One row per finding, from either auditor site.
CREATE TABLE IF NOT EXISTS auditor_findings (
  id TEXT PRIMARY KEY,
  -- 'pipeline' = §4A, auditing a user's generation run.
  -- 'diff'     = §4B, auditing a staged diff in this repo before a commit.
  -- Kept in one table because the finding shape and the questions asked of it
  -- ("what is the finding rate", "is the auditor ever failing anything") are
  -- the same for both, and splitting them would mean asking twice.
  source TEXT NOT NULL CHECK (source IN ('pipeline', 'diff')),

  -- §4A: the pipeline_runs.id being audited. §4B: null.
  pipeline_run_id TEXT,
  -- §4B: the git SHA the diff was audited against. §4A: null.
  commit_sha TEXT,

  -- Which model produced this finding. Recorded per row rather than assumed,
  -- because AUDITOR_MODEL is overridable at runtime and findings from two
  -- different auditors are not comparable.
  model TEXT NOT NULL,

  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  category TEXT NOT NULL,

  -- A finding without a file and a line is a suggestion. §4B req 4 rejects
  -- those, so these are NOT NULL for diff audits; pipeline findings are about
  -- research rather than code and legitimately have neither.
  file TEXT,
  line INTEGER,

  summary TEXT NOT NULL,
  -- The concrete "these inputs produce this wrong output" scenario. Required:
  -- it is the difference between a finding and an opinion.
  failure_scenario TEXT NOT NULL,

  -- Set when a HIGH was overruled rather than fixed. §4B req 5 allows
  -- disagreeing with a finding and forbids disappearing it, so the
  -- justification is stored next to the finding it overrules.
  overruled_reason TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auditor_findings_run
  ON auditor_findings(pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_auditor_findings_commit
  ON auditor_findings(commit_sha);
-- Answers "is the gate still working" — the §4B req 3 finding rate — without a
-- table scan.
CREATE INDEX IF NOT EXISTS idx_auditor_findings_rate
  ON auditor_findings(source, created_at);

-- One row per audit *call*, whether or not it found anything.
--
-- Separate from the findings because a clean audit produces zero finding rows,
-- and "the auditor ran and found nothing" and "the auditor never ran" must not
-- look the same. That distinction is the whole of §4B req 3: an auditor
-- returning clean on every diff is evidence the gate is broken, and you can
-- only see that if the clean runs are recorded.
CREATE TABLE IF NOT EXISTS auditor_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('pipeline', 'diff')),
  pipeline_run_id TEXT,
  commit_sha TEXT,
  model TEXT NOT NULL,

  findings_high INTEGER NOT NULL DEFAULT 0,
  findings_medium INTEGER NOT NULL DEFAULT 0,
  findings_low INTEGER NOT NULL DEFAULT 0,

  -- Cost and latency, per §4A req 4 and §4B req 7. Adding a second provider to
  -- every run has a price; this is where the number to report comes from.
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,

  -- 'completed'  — the auditor answered.
  -- 'refused'    — it declined for want of evidence (§4B req 2). Not a pass.
  -- 'unreachable'— it could not be called. Also not a pass: §4A req 2 requires
  --                the pipeline to stop at the gate rather than fall through.
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'refused', 'unreachable')),
  error TEXT,

  -- Set on a calibration run (§4B req 3): the planted defect, and whether it
  -- was caught. NULL on a normal audit.
  calibration_defect TEXT,
  calibration_caught INTEGER CHECK (calibration_caught IN (0, 1)),

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auditor_runs_rate
  ON auditor_runs(source, outcome, created_at);

-- §4C: one row per attempt at healing one distinct failure.
--
-- MAX_ATTEMPTS is 3 and escalation is a deliverable rather than a failure
-- notice, so the escalation is stored here too — attempt rows and the report
-- that ends them belong to the same record.
CREATE TABLE IF NOT EXISTS self_healing_attempts (
  id TEXT PRIMARY KEY,

  -- Stable identity for one distinct failure across its attempts, so
  -- "attempt 2 of 3" is a fact about a failure rather than about a session.
  failure_key TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 3),

  -- CAPTURE: exact command, exact output, exact exit code. Stored verbatim
  -- because a paraphrased failure is not reproducible, and step 2 of the loop
  -- is diagnosing a root cause — which needs the real output, not a summary.
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  output TEXT NOT NULL,

  -- DIAGNOSE: the root cause, not the symptom. "Flaky" is explicitly not an
  -- acceptable value and the loop is not allowed to write it.
  diagnosis TEXT,
  -- FIX: what was actually changed.
  fix_summary TEXT,

  -- 'fixed'      — the full gate passed afterwards.
  -- 'failed'     — it did not; another attempt follows, or the budget ran out.
  -- 'escalated'  — stopped deliberately. Either the attempt budget was spent,
  --                the failures stopped converging, or the only available fix
  --                was a banned one (weakening the check), which is an
  --                escalation and never a fix.
  outcome TEXT NOT NULL CHECK (outcome IN ('fixed', 'failed', 'escalated')),

  -- Why it stopped, when it stopped: 'max_attempts', 'no_convergence',
  -- 'would_weaken_check'. NULL unless outcome = 'escalated'.
  escalation_reason TEXT,
  escalation_report TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_self_healing_failure
  ON self_healing_attempts(failure_key, attempt);
-- "A loop that always needs three attempts is telling you something about the
-- codebase" — this is the index that lets you ask.
CREATE INDEX IF NOT EXISTS idx_self_healing_outcome
  ON self_healing_attempts(outcome, created_at);

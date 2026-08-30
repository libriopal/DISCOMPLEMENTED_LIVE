-- Migration 022: Iterative Agent Loop State Machine
-- Adds iteration tracking and explicit phase state to pipeline_runs
-- Implements the Orchestration Protocol: Iterative Agent Loop (N_max = 5)

-- Track how many times the full pipeline (Research→Audit→Verify→Design→Code)
-- has looped. Capped at 5 iterations — if gates haven't passed by then,
-- the pipeline terminates with a "max_iterations_reached" status.
ALTER TABLE pipeline_runs ADD COLUMN iteration_count INTEGER DEFAULT 0;

-- Explicit phase tracking for the state machine
-- Values: research | audit | verify | design | code | complete | rejected
ALTER TABLE pipeline_runs ADD COLUMN pipeline_phase TEXT DEFAULT 'research';

-- Store the full state artifacts as the protocol specifies
-- These are the "Global Context State" variables
ALTER TABLE pipeline_runs ADD COLUMN research_brief TEXT;
ALTER TABLE pipeline_runs ADD COLUMN audit_report TEXT;
ALTER TABLE pipeline_runs ADD COLUMN verification_report TEXT;
ALTER TABLE pipeline_runs ADD COLUMN code_artifacts TEXT;

-- Track which gates have passed in the current iteration
-- JSON: { "researcher": true, "auditor": false, "verifier": null, "designer": null, "coder": null }
ALTER TABLE pipeline_runs ADD COLUMN gate_results TEXT;

-- Track the final verdict: APPROVE | REJECT | MAX_ITERATIONS
ALTER TABLE pipeline_runs ADD COLUMN final_verdict TEXT;

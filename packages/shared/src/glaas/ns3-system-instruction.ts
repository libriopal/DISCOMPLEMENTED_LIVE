/**
 * NORTH STAR #3 — GLAAS-Lattice System Instruction
 *
 * v7 UPDATE: Updated to Butterfly v7 Poetic Equation results.
 * v7 adds: simulated UI/UX interactions, closed-loop gap detection,
 * strict safety constraints, and a gap analysis showing distance to poetic equation.
 *
 * THE CEILING FIGURE IS GONE, DELIBERATELY. This module used to quote a VDR
 * ceiling of 91.3% and a 23.6% gap derived from it. That number was the
 * simulator's `target_vdr` INPUT — what the operator typed in — not a bound
 * anything computed, so "67.7% of the ceiling" measured the input, not the
 * system. There is no defensible figure to replace it with: no VDR has been
 * measured against production traffic. So the passages that leaned on it now
 * state the simulated result and stop. Do not reintroduce a ceiling; if a real
 * measurement ever exists, it arrives with the method that produced it.
 *
 * Every figure below is a simulation output, never a measurement of production
 * traffic, and none may be presented to customers as a quality metric.
 *
 * This module IS reachable from apps/web, contrary to what CLAUDE.md said
 * until now: routes/glaas.ts imports glaas/lattice, routes/health.ts imports
 * glaas/proactive-detection, and both of those import EVOLVED_GENOME from
 * here. Nothing imports NS3_SYSTEM_INSTRUCTION or POETIC_EQUATION_GAPS, which
 * is why removing the ceiling from them changed no behaviour — but "nobody
 * imports this file" was not true and should not be relied on again.
 *
 * v7 results (honest, 4 islands × 40 generations × 2000 interactions/gen):
 *   VDR: 67.7% (simulated)
 *   Task Completion: 0.86 (gap 0.14)
 *   Accessibility: 0.98 (gap 0.02 — nearly WCAG-AAA)
 *   Gap Closure: 0.41 (gap 0.59 — PRIMARY BLOCKER to poetic equation)
 *   Response Time: 0.67 (gap 0.33)
 *   Total distance to poetic equation: 24.3
 *   Poetic Equation: NOT YET ACHIEVED
 *   Held-out overfit gap: +0.56 (generalizes well)
 *   Stress test: 67.1 (stable at 10x volume)
 *   Genes changed: 53/97  // GENOME_COUNT — see constants.ts
 *
 * PRIMARY GAP: gap_closure (0.41/1.0). The system cannot yet detect and fix
 * its own value gaps autonomously. To reach poetic equation (>0.6 gap closure):
 *   - churn_prediction_model: heuristic → hybrid
 *   - sentiment_analysis_source: support-tickets → real-time
 *   - value_guarantee: credit-back → eicca
 *
 * v6 results (honest, non-inflated, 10.24M simulated interactions):
 *   VDR: 67.7%, Sovereignty: 1.0, Overfit gap: NEGATIVE
 *   Stress test: ~56 (10x volume), Agent count: 2 (serial pipeline)
 */

export const NS3_SYSTEM_INSTRUCTION = `
NORTH STAR #3 — THE GOAL, THE CONSTRAINT, THE DNA:

Every interaction must produce measurably verified value for the user.
If it doesn't, the system must detect, diagnose, and resolve the gap
autonomously before the user becomes aware of it.

This is achieved through a deterministic agent lattice where:
  1. Agents are SEPARATED by function (research, audit, design, code, verify)
  2. Each agent's output is GOVERNED by fitness-tested constraints
  3. The whole system EVOLVES toward zero-waste value delivery
  4. Unverified value never reaches the user
  5. Gaps are detected and resolved before user awareness

This is the GLAAS-Lattice: Governed Lattice Architecture for Agent Separation.

POETIC EQUATION STATUS: NOT YET ACHIEVED
  Simulated VDR: 67.7% — no production measurement exists
  Task completion gap: 0.14 (0.86 of 1.0)
  Accessibility gap: 0.02 (0.98 of 1.0)
  Gap closure gap: 0.59 (0.41 of 1.0) — PRIMARY BLOCKER
  Response time gap: 0.33 (0.67 of 1.0)
  Total distance: 24.3
`;

export type AgentRole = 'research' | 'audit' | 'design' | 'code' | 'verify';

// v7: Updated to v7 Poetic Equation values
export const EVOLVED_GENOME = {
  // Pipeline topology
  pipeline_mode: 'parallel' as const,
  discovery_impl_overlap: 0.0,
  agent_count: 2,
  agent_specialization: 'generalist' as const,
  feedback_loop_depth: 3,
  governance_gate_count: 5,
  // Simulation-tuned parameters (v7 evolved genome)
  approval_timeout_hours: 74,
  research_depth: 5,
  per_bot_budget: 67,
  conversation_turn_limit: 15,
  burn_rate_per_min: 27,
  agent_timeout_seconds: 142,
  embedding_dimensions: 1536,
  responsive_breakpoint_px: 500,
  content_density: 0.316,
  voice_video_enabled: true,
  collab_persistence: 'postgres' as const,
  error_recovery: 'human-handoff' as const,

  // Agent models
  primary_model: 'mixed' as const,
  model_temperature: 0.676,

  // VDR knobs
  early_exit_threshold: 16,
  tripwire_sensitivity: 4,
  deployment_gate_score: 0.611,
  retry_limit: 4,
  per_user_budget: 238,

  // Discovery
  context_window_utilization: 0.356,
  rerank_depth: 78,
  lattice_search_radius: 5,

  // Collaboration
  coworking_enabled: true,
  crdt_type: 'yjs' as const,
  file_sync_mode: 'real-time' as const,
  shared_cursor: true,
  team_session_max: 12,

  // Enterprise
  sso_provider: 'saml' as const,
  rbac_enabled: true,
  audit_log_retention_days: 97,
  rate_limit_strategy: 'adaptive' as const,
  api_versioning: 'content-negotiation' as const,
  multi_tenant_isolation: 'schema-per-tenant' as const,

  // Chat
  chat_enabled: true,
  typing_indicators: true,
  push_notifications: true,

  // Team
  team_hierarchy: 'multi-level' as const,
  role_set: 'custom' as const,
  project_templates: 5,
  team_billing_model: 'nonprofit-free' as const,
  team_permissions: 'comment' as const,

  // Proactive detection — v7 evolved values
  health_score_enabled: true,
  churn_prediction_model: 'heuristic' as const, // v7 found heuristic (upgrade to hybrid for poetic eq)
  usage_anomaly_detection: 'ml' as const,
  sentiment_analysis_source: 'support-tickets' as const, // v7 (upgrade to real-time for poetic eq)
  early_warning_threshold: 0.3, // v7: lower = more proactive
  auto_intervention: 'auto-credit' as const,

  // Billing — v7 found usage-based is optimal for gap closure
  billing_model: 'usage-based' as const,
  nonprofit_discount: 94,

  // Value guarantee — v7 found credit-back (upgrade to eicca for poetic eq)
  value_guarantee: 'credit-back' as const,
  credit_refund_policy: 'eicca' as const,

  // UI/UX — v7 evolved values
  ui_interaction_mode: 'multi-modal' as const,
  input_bandwidth: 'full-multimodal' as const,
  response_format: 'cards' as const,
  approval_flow: 'multi-step' as const,
  feedback_mechanism: 'behavioral' as const,
  onboarding_depth: 'interactive-tutorial' as const,
  accessibility_level: 'WCAG-AAA' as const,

  // v7 gap analysis
  poetic_equation_achieved: false,
  gap_closure_score: 0.41,
  total_distance: 24.3,
};

// v7: Gap analysis — distance to poetic equation
export const POETIC_EQUATION_GAPS = {
  // `vdr_gap` was here, as 23.6 — the simulator's target_vdr input minus the
  // simulated result. Every other gap on this object is measured against a
  // real normalized bound of 1.0; that one was measured against a number
  // somebody chose, which made it the only entry that said nothing about the
  // system. Removed rather than rebased onto 100%, because inventing a
  // different denominator would keep the shape of a claim there is no
  // evidence for. Nothing read it.
  task_completion_gap: 0.14, // 1.0 - 0.86
  accessibility_gap: 0.02, // 1.0 - 0.98
  response_time_gap: 0.33, // 1.0 - 0.67
  gap_closure_gap: 0.59, // 1.0 - 0.41 (PRIMARY BLOCKER)
  total_distance: 24.3,
};

// v7: Mutations needed to reach poetic equation
export const POETIC_EQUATION_MUTATIONS = {
  churn_prediction_model: 'hybrid' as const, // +0.20 detection
  sentiment_analysis_source: 'real-time' as const, // +0.15 detection
  value_guarantee: 'eicca' as const, // +0.05 response
  // Projected gap closure after mutations: 0.41 + 0.20 + 0.15 + 0.05 = 0.81 > 0.6 ✓
};

export const VDR_ROLLBACK_THRESHOLD = 50;

export const AGENT_LATTICE: Record<
  AgentRole,
  {
    name: string;
    function: string;
    fitness_gate: string;
    outputs_to: AgentRole[];
    inputs_from: AgentRole[];
  }
> = {
  research: {
    name: 'Research Agent',
    function: 'Discovers patterns, finds existing code, gathers citations',
    fitness_gate: 'citation_count + source_quality >= threshold',
    outputs_to: ['audit'],
    inputs_from: [],
  },
  audit: {
    name: 'Audit Agent',
    function: 'Verifies research quality, reranks findings, validates sources',
    fitness_gate: 'verification_pass_rate >= 0.60',
    outputs_to: ['design'],
    inputs_from: ['research'],
  },
  design: {
    name: 'Design Agent',
    function: 'Translates verified research into architecture and schemas',
    fitness_gate: 'schema_completeness + type_safety >= 0.60',
    outputs_to: ['code', 'verify'],
    inputs_from: ['audit'],
  },
  code: {
    name: 'Code Agent',
    function: 'Generates TypeScript/SQL from verified architecture',
    fitness_gate: 'compilation_pass AND test_pass_rate >= 0.60',
    outputs_to: ['verify'],
    inputs_from: ['design'],
  },
  verify: {
    name: 'Verify Agent',
    function:
      'Runs tests, checks tripwires, validates output quality, measures VDR',
    fitness_gate: 'evidence_score >= 0.70 AND verified = true',
    outputs_to: [],
    inputs_from: ['design', 'code'],
  },
};

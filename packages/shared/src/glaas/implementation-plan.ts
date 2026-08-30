/**
 * DISCOMPLEMENT IMPLEMENTATION PLAN — Updated to Butterfly v6 Honest
 *
 * P2 FIX: All parameters updated from v5 (inflated) to v6 (honest Monte Carlo).
 * The shipped v5 constants disagreed with the v6 report on nearly everything.
 * v6 is the honest source of truth: additive, capped, held-out validated.
 *
 * EVOLVED PARAMETERS (v6 honest, non-inflated):
 * - System prompt: Socratic style (research-supported)
 * - Pipeline: serial (NOT parallel — v6 found serial is optimal)
 * - Agent separation: 5 roles (research → audit → design → code → verify)
 * - Agent count: 2 (NOT 5)
 * - VDR: 67.7% (simulated result; the cap it used to be compared against was
 *   a simulator input and has been removed — see ns3-system-instruction.ts)
 * - Model temperature: 0.397 (NOT 0.185)
 * - Deployment gate: 0.355 (NOT 0.319)
 * - Feedback loops: 3 (NOT 5)
 * - Rerank depth: 37, lattice search radius: 5
 * - Per-user budget: 197 credits (NOT 448)
 * - Retry limit: 4 (NOT 5)
 * - Discovery/impl overlap: 0.0 (NOT 77.3%)
 *
 * ROLLBACK THRESHOLD: 50% (from measured stress test baseline ~56%, NOT aspirational 70%)
 *
 * CONSTRAINTS (from v6 honest simulation):
 * - 10.24M SIMULATED interactions (not real user traffic)
 * - Overfit gap NEGATIVE — architecture generalizes to unseen data
 * - Sovereignty 1.0 — maximum data control is always optimal
 * - Complexity penalty active — simpler architectures score higher
 * - Exploit detection active — prevents gaming the simulation
 */

export const IMPLEMENTATION_PHASES = [
  {
    phase: 1,
    name: 'Update NS3 System Instruction',
    file: 'packages/shared/src/glaas/ns3-system-instruction.ts',
    action:
      'Replace NS3_SYSTEM_INSTRUCTION with EVOLVED_SYSTEM_PROMPT (Socratic, affirmative). Update EVOLVED_GENOME with v6 honest values.',
    risk: 'LOW — prompt text only, no runtime change',
  },
  {
    phase: 2,
    name: 'Wire GLAAS-Lattice into routes',
    file: 'src/server/index.ts',
    action:
      'Import lattice engine, expose /api/lattice/status and /api/lattice/topology endpoints',
    risk: 'MEDIUM — new routes, needs auth guard',
  },
  {
    phase: 3,
    name: 'Deploy proactive detection to D1',
    files: [
      'migrations/015_health_scores.sql',
      'packages/shared/src/glaas/proactive-detection.ts',
    ],
    action:
      'Create health_scores table (unique user_id + upsert), wire calculateHealthScore to /api/health endpoint',
    risk: 'MEDIUM — new migration, needs testing',
  },
  {
    phase: 4,
    name: 'Update evolved genome constants',
    file: 'packages/shared/src/glaas/ns3-system-instruction.ts',
    action:
      'Update EVOLVED_GENOME with v6 honest values (VDR 67.7%, serial pipeline, 2 agents, temp 0.397, budget 197, retry 4)',
    risk: 'LOW — constants only',
  },
  {
    phase: 5,
    name: 'Add island-specific prompts to agent router',
    file: 'packages/cohere/src/model-router.ts',
    action: 'Route agents to island-specific prompts based on user context',
    risk: 'MEDIUM — changes agent behavior',
  },
  {
    phase: 6,
    name: 'Deploy and validate',
    action:
      'Deploy to Cloudflare, run VDR measurement against real traffic, compare to simulated baseline (67.7%), rollback if below 50%',
    risk: 'HIGH — production deployment',
  },
];

export const V6_RESULTS = {
  totalSimulatedInteractions: 10240000,
  islands: {
    solo_dev: {
      train: 56.3,
      held_out: 56.4,
      vdr: 66.2,
      sovereignty: 1.0,
      stress: 55.84,
    },
    startup: {
      train: 56.5,
      held_out: 57.2,
      vdr: 67.8,
      sovereignty: 1.0,
      stress: 56.19,
    },
    enterprise: {
      train: 56.5,
      held_out: 57.2,
      vdr: 67.7,
      sovereignty: 1.0,
      stress: 56.18,
    },
    nonprofit: {
      train: 56.5,
      held_out: 56.9,
      vdr: 67.6,
      sovereignty: 1.0,
      stress: 56.07,
    },
  },
  rollbackThreshold: 50,
  // `vdrCeiling` was here. It was the simulator's `target_vdr` input from
  // simulation/butterfly_report*.json — a parameter, not a bound anything
  // derives — and naming it a ceiling in an exported config is how a typed-in
  // number becomes a quality claim. Nothing read it. The run it described is
  // still described by the island results above.
  bestIsland: 'enterprise',
  overfitGapNegative: true,
};

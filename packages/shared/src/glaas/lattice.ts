import {
  EVOLVED_GENOME,
  AgentRole,
  AGENT_LATTICE,
} from './ns3-system-instruction';

export interface LatticeNode {
  role: AgentRole;
  status: 'pending' | 'running' | 'gated' | 'passed' | 'failed';
  fitness_score: number; // P1: normalized 0-1 scale
  artifacts: string[];
  credits_spent: number;
  value_produced: number;
  retries_used: number; // P1: track retries per node
}

export interface LatticeExecution {
  id: string;
  nodes: Record<AgentRole, LatticeNode>;
  vdr: number;
  zero_waste_score: number;
  total_credits: number;
  value_credits: number;
  status: 'running' | 'completed' | 'failed';
  created_at: string;
}

// P1: Gate threshold normalized to 0-1 (was 0.319 which was on a different scale)
const NODE_GATE = 0.6;

export function initLattice(): LatticeExecution {
  const nodes = {} as Record<AgentRole, LatticeNode>;
  (Object.keys(AGENT_LATTICE) as AgentRole[]).forEach((role) => {
    nodes[role] = {
      role,
      status: 'pending',
      fitness_score: 0,
      artifacts: [],
      credits_spent: 0,
      value_produced: 0,
      retries_used: 0,
    };
  });
  return {
    id: `lattice-${Date.now()}`,
    nodes,
    vdr: 0,
    zero_waste_score: 0,
    total_credits: 0,
    value_credits: 0,
    status: 'running',
    created_at: new Date().toISOString(),
  };
}

// P1: Clone input first (was mutating caller's object)
export function stepLattice(
  lattice: LatticeExecution,
  role: AgentRole,
  result: {
    fitness_score: number; // P1: 0-1 normalized
    artifacts: string[];
    credits_spent: number;
    value_produced: number;
  }
): LatticeExecution {
  // P1: Deep clone to avoid mutating caller's object
  const next: LatticeExecution = JSON.parse(JSON.stringify(lattice));
  const node = next.nodes[role];
  node.fitness_score = result.fitness_score;
  node.artifacts = result.artifacts;
  node.credits_spent = result.credits_spent;
  node.value_produced = result.value_produced;

  // P1: Gate check with normalized threshold
  if (result.fitness_score >= NODE_GATE) {
    node.status = 'passed';
  } else {
    // P1: Honor retries — don't fail the whole lattice on first sub-gate miss
    if (node.retries_used < EVOLVED_GENOME.retry_limit) {
      node.retries_used++;
      node.status = 'gated'; // Will retry, not failed
    } else {
      node.status = 'failed';
      next.status = 'failed';
    }
    return next;
  }

  next.total_credits += result.credits_spent;
  next.value_credits += result.value_produced;
  next.vdr =
    next.total_credits > 0
      ? (next.value_credits / next.total_credits) * 100
      : 0;
  next.zero_waste_score =
    next.total_credits > 0 ? next.value_credits / next.total_credits : 0;

  // P1: Only mark completed if ALL nodes are passed (not gated/failed)
  const allPassed = Object.values(next.nodes).every(
    (n) => n.status === 'passed'
  );
  if (allPassed) {
    next.status = 'completed';
  }
  return next;
}

export function shouldEarlyExit(
  credits_spent: number,
  files_generated: number
): boolean {
  return (
    credits_spent >= EVOLVED_GENOME.early_exit_threshold &&
    files_generated === 0
  );
}

export function checkTripwires(tripwire_hits: number): boolean {
  return tripwire_hits >= EVOLVED_GENOME.tripwire_sensitivity;
}

export function getLatticeTopology() {
  return {
    nodes: Object.entries(AGENT_LATTICE).map(([role, def]) => ({
      id: role,
      label: def.name,
      function: def.function,
      gate: def.fitness_gate,
    })),
    edges: Object.entries(AGENT_LATTICE).flatMap(([role, def]) =>
      def.outputs_to.map((target) => ({ source: role, target }))
    ),
    genome: EVOLVED_GENOME,
  };
}

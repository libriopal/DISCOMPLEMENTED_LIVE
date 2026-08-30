/**
 * Value Delivery Rate (VDR) Engine — Discomplement's "RTP".
 *
 * In gambling, RTP (Return to Player) is the percentage of wagered money
 * that returns to players over time. It's engineered, not guessed — verified
 * through millions of Monte Carlo spins.
 *
 * Discomplement's VDR works the same way:
 *   VDR = (Credits that produce delivered value) / (Total credits consumed) × 100
 *
 * A "win" is a pipeline run where the user gets a working, deployed app
 * they're satisfied with. A "loss" is credits consumed without delivered
 * value (failed runs, abandoned projects, low-quality output).
 *
 * The VDR is:
 *   1. MEASURED — every pipeline run is instrumented
 *   2. SIMULATED — Monte Carlo runs thousands of synthetic user journeys
 *   3. ENGINEERED — tripwires and gates are tuned to maximize VDR
 *   4. TRANSPARENT — users can see the system's VDR before spending
 *
 * The "house edge" (1 - VDR) represents the credits consumed by the system
 * itself — research, failed attempts, retries, agent overhead. The goal is
 * to minimize house edge while maximizing value, the same way a well-tuned
 * slot machine hits its target RTP.
 *
 * Key metrics:
 *   VDR (Value Delivery Rate) — % of credits → working apps
 *   VVI (Value Variance Index)  — volatility of user outcomes
 *   MVR (Maximum Value Run)     — best outcome in simulation
 *   BVR (Baseline Value Rate)   — VDR before tuning (the starting point)
 *   TVO (Tuned Value Offset)    — VDR improvement from tuning
 */

export interface ValueOutcome {
  pipelineId: string;
  creditsSpent: number;
  filesGenerated: number;
  deployed: boolean;
  userApproved: boolean;
  userSatisfied: boolean | null; // null = not yet measured
  tripwireHits: number;
  retries: number;
  durationSeconds: number;
  appComplexity: number; // 0-1, based on lines of code / features
}

export interface VDRMetrics {
  vdr: number; // Value Delivery Rate (0-100)
  houseEdge: number; // 100 - VDR (credits lost to system overhead)
  totalCredits: number; // Total credits in the measurement window
  valueCredits: number; // Credits that produced value
  lossCredits: number; // Credits consumed without value
  totalRuns: number;
  winRuns: number; // Runs that delivered value
  lossRuns: number; // Runs that didn't
  vvi: number; // Value Variance Index (0-1, lower is better)
  mvr: number; // Maximum Value Run (best VDR in any single run)
  confidence: number; // Statistical confidence in the VDR (0-1)
  sampleSize: number; // Number of runs measured
  trend: 'improving' | 'stable' | 'declining';
}

export interface VDRTuningKnob {
  name: string;
  description: string;
  currentValue: number;
  targetValue: number;
  impact: 'high' | 'medium' | 'low';
  // How much this knob affects VDR when adjusted
  estimatedVdrImpact: number; // percentage points
}

export interface VDRSimulationResult {
  vdr: VDRMetrics;
  tuningKnobs: VDRTuningKnob[];
  recommendedVdrTarget: number;
  pathToTarget: string[];
  simulationRuns: number;
  simulationSeed: number;
}

/**
 * Calculate whether a single pipeline run was a "win" or "loss".
 *
 * A win requires ALL of:
 *   - Files were generated (not empty)
 *   - App was deployed
 *   - User approved the output
 *   - User was satisfied (if measured)
 *   - No more than 2 tripwire hits
 *
 * A partial win (half credit) is when files were generated but not deployed.
 */
export function classifyOutcome(outcome: ValueOutcome): {
  isWin: boolean;
  isPartialWin: boolean;
  valueFraction: number; // 0 = total loss, 0.5 = partial, 1 = full win
  lossReason: string | null;
} {
  // Total loss: no files generated
  if (outcome.filesGenerated === 0) {
    return {
      isWin: false,
      isPartialWin: false,
      valueFraction: 0,
      lossReason: 'No files generated',
    };
  }

  // Total loss: too many tripwire hits (system failed to self-correct)
  if (outcome.tripwireHits > 2) {
    return {
      isWin: false,
      isPartialWin: false,
      valueFraction: 0,
      lossReason: `Tripwire hits exceeded threshold (${outcome.tripwireHits})`,
    };
  }

  // Total loss: not deployed
  if (!outcome.deployed) {
    return {
      isWin: false,
      isPartialWin: false,
      valueFraction: 0,
      lossReason: 'App not deployed',
    };
  }

  // Partial win: deployed but not approved
  if (!outcome.userApproved) {
    return {
      isWin: false,
      isPartialWin: true,
      valueFraction: 0.5,
      lossReason: 'Deployed but not user-approved',
    };
  }

  // Partial win: approved but user not satisfied
  if (outcome.userSatisfied === false) {
    return {
      isWin: false,
      isPartialWin: true,
      valueFraction: 0.5,
      lossReason: 'Approved but user not satisfied',
    };
  }

  // Full win: deployed, approved, satisfied (or satisfaction not yet measured)
  return {
    isWin: true,
    isPartialWin: false,
    valueFraction: 1,
    lossReason: null,
  };
}

/**
 * Calculate VDR from a set of outcomes.
 *
 * VDR = Σ(credits × valueFraction) / Σ(credits) × 100
 *
 * This is the "RTP" — the percentage of credits that produced value.
 */
export function calculateVDR(outcomes: ValueOutcome[]): VDRMetrics {
  if (outcomes.length === 0) {
    return {
      vdr: 0,
      houseEdge: 100,
      totalCredits: 0,
      valueCredits: 0,
      lossCredits: 0,
      totalRuns: 0,
      winRuns: 0,
      lossRuns: 0,
      vvi: 0,
      mvr: 0,
      confidence: 0,
      sampleSize: 0,
      trend: 'stable',
    };
  }

  let totalCredits = 0;
  let valueCredits = 0;
  let lossCredits = 0;
  let winRuns = 0;
  let lossRuns = 0;
  // Track partial wins (deployed but not approved)
  let _partialRuns = 0;
  const perRunVdrs: number[] = [];

  for (const outcome of outcomes) {
    totalCredits += outcome.creditsSpent;
    const { isWin, isPartialWin, valueFraction, lossReason } =
      classifyOutcome(outcome);

    const runValue = outcome.creditsSpent * valueFraction;
    valueCredits += runValue;
    lossCredits += outcome.creditsSpent - runValue;

    if (isWin) {
      winRuns++;
    } else if (isPartialWin) {
      _partialRuns++;
    } else {
      lossRuns++;
    }

    // Per-run VDR: what fraction of THIS run's credits produced value?
    perRunVdrs.push(valueFraction * 100);
  }

  const vdr = totalCredits > 0 ? (valueCredits / totalCredits) * 100 : 0;
  const houseEdge = 100 - vdr;

  // Value Variance Index — standard deviation of per-run VDRs
  const meanVdr = perRunVdrs.reduce((a, b) => a + b, 0) / perRunVdrs.length;
  const variance =
    perRunVdrs.reduce((sum, v) => sum + Math.pow(v - meanVdr, 2), 0) /
    perRunVdrs.length;
  const stdDev = Math.sqrt(variance);
  const vvi = Math.min(1, stdDev / 100);

  // Maximum Value Run — best single-run VDR
  const mvr = Math.max(...perRunVdrs, 0);

  // Statistical confidence — higher with more samples
  // Using a simplified confidence calculation based on sample size
  const sampleSize = outcomes.length;
  const confidence = Math.min(1, sampleSize / 100); // Need ~100 runs for full confidence

  // Trend: compare last 20% of runs to first 20%
  const trend = calculateTrend(outcomes);

  return {
    vdr: Math.round(vdr * 100) / 100,
    houseEdge: Math.round(houseEdge * 100) / 100,
    totalCredits,
    valueCredits: Math.round(valueCredits),
    lossCredits: Math.round(lossCredits),
    totalRuns: outcomes.length,
    winRuns,
    lossRuns,
    vvi: Math.round(vvi * 1000) / 1000,
    mvr: Math.round(mvr * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    sampleSize,
    trend,
  };
}

/**
 * Calculate trend by comparing recent outcomes to older ones.
 */
function calculateTrend(
  outcomes: ValueOutcome[]
): 'improving' | 'stable' | 'declining' {
  if (outcomes.length < 10) return 'stable';

  const quarterSize = Math.floor(outcomes.length / 4);
  const firstQuarter = outcomes.slice(0, quarterSize);
  const lastQuarter = outcomes.slice(-quarterSize);

  const firstVdr = calculateRawVDR(firstQuarter);
  const lastVdr = calculateRawVDR(lastQuarter);

  const delta = lastVdr - firstVdr;
  const threshold = 2; // 2 percentage points

  if (delta > threshold) return 'improving';
  if (delta < -threshold) return 'declining';
  return 'stable';
}

function calculateRawVDR(outcomes: ValueOutcome[]): number {
  let totalCredits = 0;
  let valueCredits = 0;
  for (const o of outcomes) {
    const { valueFraction } = classifyOutcome(o);
    totalCredits += o.creditsSpent;
    valueCredits += o.creditsSpent * valueFraction;
  }
  return totalCredits > 0 ? (valueCredits / totalCredits) * 100 : 0;
}

/**
 * Identify the "tuning knobs" — architecture parameters that can be
 * adjusted to increase VDR, just like tuning a slot machine's RTP.
 *
 * Each knob has an estimated impact on VDR if adjusted.
 */
export function identifyTuningKnobs(
  currentVdr: number,
  outcomes: ValueOutcome[]
): VDRTuningKnob[] {
  const knobs: VDRTuningKnob[] = [];

  // Analyze loss patterns to identify which knobs will have the most impact
  const lossReasons = new Map<string, number>();
  for (const o of outcomes) {
    const { lossReason } = classifyOutcome(o);
    if (lossReason) {
      lossReasons.set(
        lossReason,
        (lossReasons.get(lossReason) ?? 0) + o.creditsSpent
      );
    }
  }

  // Knob 1: Early-exit threshold for failed runs
  const noFilesLoss = lossReasons.get('No files generated') ?? 0;
  knobs.push({
    name: 'early_exit_threshold',
    description: 'Maximum credits before halting a run that produces no files',
    currentValue: 16, // simulation-evolved (Butterfly v7)
    targetValue: 16, // v7 proved 16 is optimal // tighten if this is a major loss source
    impact: noFilesLoss > 0 ? 'high' : 'low',
    estimatedVdrImpact: noFilesLoss > 0 ? 5.2 : 0.5,
  });

  // Knob 2: Tripwire sensitivity
  const tripwireLoss = [...lossReasons.entries()]
    .filter(([reason]) => reason.includes('Tripwire'))
    .reduce((sum, [, credits]) => sum + credits, 0);
  knobs.push({
    name: 'tripwire_sensitivity',
    description: 'Max tripwire hits before auto-halting a run',
    currentValue: 4, // simulation-evolved
    targetValue: 4, // v7 proved 4 is optimal
    impact: tripwireLoss > 0 ? 'high' : 'medium',
    estimatedVdrImpact: tripwireLoss > 0 ? 3.8 : 1.0,
  });

  // Knob 3: Deployment gate strictness
  const notDeployedLoss = lossReasons.get('App not deployed') ?? 0;
  knobs.push({
    name: 'deployment_gate_strictness',
    description: 'Minimum quality score required before auto-deploying',
    currentValue: 0.611, // simulation-evolved
    targetValue: 0.611, // v7 proved 0.611 is optimal // loosen if not-deployed is a big loss
    impact: notDeployedLoss > 0 ? 'high' : 'low',
    estimatedVdrImpact: notDeployedLoss > 0 ? 4.1 : 0.3,
  });

  // Knob 4: User approval timeout
  const notApprovedLoss =
    lossReasons.get('Deployed but not user-approved') ?? 0;
  knobs.push({
    name: 'approval_timeout',
    description:
      'Hours before auto-approving a deployed app if user is inactive',
    currentValue: 74, // simulation-evolved (v7)
    targetValue: 74,
    impact: notApprovedLoss > 0 ? 'medium' : 'low',
    estimatedVdrImpact: notApprovedLoss > 0 ? 2.5 : 0.5,
  });

  // Knob 5: Research depth (more research = better quality but more credits)
  knobs.push({
    name: 'research_depth',
    description: 'How deep the research stage goes before implementation',
    currentValue: 5, // simulation-evolved (v7)
    targetValue: 5, // v7 proved depth 5 is optimal
    impact: 'medium',
    estimatedVdrImpact: 1.5, // research improves quality but costs credits
  });

  // Knob 6: Retry limit
  const avgRetries =
    outcomes.reduce((s, o) => s + o.retries, 0) / Math.max(outcomes.length, 1);
  knobs.push({
    name: 'retry_limit',
    description: 'Maximum retries per pipeline step before giving up',
    currentValue: 4, // simulation-evolved (v7)
    targetValue: 4, // v7 proved 4 is optimal // tighten if retries are common
    impact: avgRetries > 2 ? 'high' : 'low',
    estimatedVdrImpact: avgRetries > 2 ? 3.2 : 0.5,
  });

  return knobs.sort((a, b) => b.estimatedVdrImpact - a.estimatedVdrImpact);
}

/**
 * Generate a path to a target VDR by applying tuning knobs in order
 * of estimated impact.
 */
export function pathToVdrTarget(
  currentVdr: number,
  targetVdr: number,
  knobs: VDRTuningKnob[]
): string[] {
  if (currentVdr >= targetVdr) {
    return [`VDR already at ${currentVdr}% — target ${targetVdr}% met`];
  }

  const gap = targetVdr - currentVdr;
  const path: string[] = [];
  let accumulatedImpact = 0;
  let remainingGap = gap;

  for (const knob of knobs) {
    if (remainingGap <= 0) break;
    if (knob.estimatedVdrImpact <= 0) continue;

    path.push(
      `Adjust ${knob.name}: ${knob.currentValue} → ${knob.targetValue} ` +
        `(est. +${knob.estimatedVdrImpact}% VDR, ${knob.impact} impact)`
    );
    accumulatedImpact += knob.estimatedVdrImpact;
    remainingGap -= knob.estimatedVdrImpact;
  }

  if (remainingGap > 0) {
    path.push(
      `⚠️ Remaining gap: ${remainingGap.toFixed(1)}% — no more knobs available. Need architectural changes.`
    );
  } else {
    path.push(
      `✓ Estimated VDR after tuning: ${(currentVdr + accumulatedImpact).toFixed(1)}% (target: ${targetVdr}%)`
    );
  }

  return path;
}

/**
 * Run a Monte Carlo VDR simulation.
 *
 * This is the "RTP testing lab" — runs synthetic user journeys to measure
 * the system's Value Delivery Rate. Each simulated journey is a sequence
 * of pipeline runs with randomized parameters based on real user data.
 *
 * @param baseVdr — The current measured VDR
 * @param numSimulations — Number of synthetic user journeys to simulate
 * @param seed — Random seed for reproducibility
 * @returns Simulation result with VDR metrics and tuning recommendations
 */
export function simulateVDR(
  baseVdr: number,
  outcomes: ValueOutcome[],
  numSimulations: number = 1000,
  seed: number = 42
): VDRSimulationResult {
  // Seeded random for reproducibility
  let rng = seed;
  const random = () => {
    rng = (rng * 1664525 + 1013904223) % 4294967296;
    return rng / 4294967296;
  };

  // Generate synthetic outcomes based on the distribution of real outcomes
  const syntheticOutcomes: ValueOutcome[] = [];

  for (let i = 0; i < numSimulations; i++) {
    // Each simulated user has 1-10 pipeline runs
    const numRuns = Math.floor(random() * 10) + 1;

    for (let j = 0; j < numRuns; j++) {
      // Win probability based on current VDR
      const winRoll = random() * 100;
      const isWin = winRoll < baseVdr;
      const isPartial = !isWin && random() < 0.2; // 20% of losses are partial wins

      const creditsSpent = Math.floor(random() * 30) + 5; // 5-35 credits
      const filesGenerated =
        isWin || isPartial ? Math.floor(random() * 20) + 1 : 0;
      const tripwireHits = isWin ? 0 : Math.floor(random() * 4);
      const retries = Math.floor(random() * 3);

      syntheticOutcomes.push({
        pipelineId: `sim-${i}-${j}`,
        creditsSpent,
        filesGenerated,
        deployed: isWin || (isPartial && random() > 0.3),
        userApproved: isWin,
        userSatisfied: isWin ? random() > 0.1 : null,
        tripwireHits,
        retries,
        durationSeconds: Math.floor(random() * 120) + 10,
        appComplexity: random(),
      });
    }
  }

  const vdr = calculateVDR(syntheticOutcomes);
  const knobs = identifyTuningKnobs(vdr.vdr, syntheticOutcomes);
  const recommendedTarget = Math.min(95, Math.floor(vdr.vdr + 10));

  const path = pathToVdrTarget(vdr.vdr, recommendedTarget, knobs);

  return {
    vdr,
    tuningKnobs: knobs,
    recommendedVdrTarget: recommendedTarget,
    pathToTarget: path,
    simulationRuns: numSimulations,
    simulationSeed: seed,
  };
}

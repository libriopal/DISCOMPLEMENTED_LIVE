/**
 * @bicameral/shared — Application constants
 * Tier limits, model defaults, rate limits, feature flags
 */
import type { AgentRole, CohereModelMap, SubscriptionTier } from './types.js';

// ============ SUBSCRIPTION TIERS ============
export const TIER_LIMITS = {
  free: {
    generationsPerDay: 5,
    creditsPerMonth: 1000, // matches free starting balance (cron doesn't reset free)
    maxTokensPerRequest: 4096,
    latticeNodes: 50,
    researchQueries: 0,
    modelAccess: ['free'] as const,
    webPreview: false,
    exportCode: false,
  },
  pro: {
    generationsPerDay: 50,
    creditsPerMonth: 50000, // matches cron-handler.ts monthly grant
    maxTokensPerRequest: 16384,
    latticeNodes: 500,
    researchQueries: 20,
    modelAccess: ['free', 'pro'] as const,
    webPreview: true,
    exportCode: true,
  },
  team: {
    generationsPerDay: 200,
    creditsPerMonth: 200000, // matches cron-handler.ts monthly grant
    maxTokensPerRequest: 32768,
    latticeNodes: 5000,
    researchQueries: 200,
    modelAccess: ['free', 'pro', 'team'] as const,
    webPreview: true,
    exportCode: true,
  },
  enterprise: {
    generationsPerDay: Infinity,
    creditsPerMonth: 1000000, // matches cron-handler.ts monthly grant
    maxTokensPerRequest: 32768,
    latticeNodes: Infinity,
    researchQueries: Infinity,
    modelAccess: ['free', 'pro', 'team', 'enterprise'] as const,
    webPreview: true,
    exportCode: true,
  },
} as const;

// ============ COHERE MODEL DEFAULTS ============
// Unlike PIPELINE_MODELS below, this map IS dispatched: consciousness.ts:370
// passes `COHERE_MODELS.pro` straight to chat(), and generate.ts does
// `COHERE_MODELS[tier]`. Keep it in step with model-router.ts.
//
// pro and team moved off command-a-reasoning-08-2025 / command-a-plus-05-2026
// on 2026-08-27: Cohere caps both at 1,000 API calls a month even on a
// production key, which is the ceiling that was ending pipeline runs. See the
// limits table in packages/cohere/src/model-router.ts. command-a-03-2025 costs
// the same per token and carries the full 500 req/min production limit with no
// monthly cap.
//
// enterprise deliberately still names Command A+ — chat() drops it to
// command-a-03-2025 on a monthly-quota 429 (quotaFallbackModel), so the tier
// gets the better model whenever the quota allows and a completed run when it
// does not.
export const COHERE_MODELS: CohereModelMap = {
  free: 'command-r7b-12-2024',
  pro: 'command-a-03-2025',
  team: 'command-a-03-2025',
  enterprise: 'command-a-plus-05-2026',
  reasoning: 'command-a-reasoning-08-2025',
  embed: 'embed-v4.0',
  rerankPro: 'rerank-v4.0-pro',
  rerankFast: 'rerank-v4.0-fast',
};

// ============ COHERE API ============
export const COHERE_API_BASE = 'https://api.cohere.com/v2';

export const COHERE_ENDPOINTS = {
  chat: '/chat',
  embed: '/embed',
  rerank: '/rerank',
  tokenize: '/tokenize',
  detectLanguage: '/detect-language',
  classify: '/classify',
} as const;

// ============ PIPELINE ============
// Reference/display copy of what model-router.ts's selectModel() resolves each
// role to. It is NOT read by selectModel() — @bicameral/cohere imports this
// package, so the dependency can't run the other way, and the router stays the
// single source of truth for dispatch.
//
// These values drifted once already (finding M-19: this map and several call
// sites still said 'command-a-03-2025' after the router switched to
// command-a-reasoning-08-2025 on 2026-08-21). Anywhere a *persisted* or
// *dispatched* model is needed, call selectModel() — not this map.
export const PIPELINE_MODELS: Record<AgentRole, string> = {
  architect: 'command-a-03-2025', // legacy role — handled by researcher
  researcher: 'command-a-03-2025',
  auditor: 'command-a-03-2025',
  verifier: 'command-a-03-2025',
  designer: 'command-a-03-2025',
  // North Mini Code was unresponsive on test (2026-08-21) — the router sends
  // every coder complexity level to Command A.
  coder: 'command-a-03-2025',
};

export const PIPELINE_STEP_ORDER: AgentRole[] = [
  'researcher',
  'auditor',
  'verifier',
  'designer',
  'coder',
];

export const PIPELINE_DEFAULTS = {
  maxCoderIterations: 5,
  approvalGateTimeoutMs: 74 * 60 * 60 * 1000, // simulation-evolved: 74h (Butterfly v7)
  // Each retry re-runs the full Coder loop (up to maxCoderIterations) with
  // the prior scan's findings fed back, then re-scans — capped separately
  // from maxCoderIterations so an app that never comes back clean doesn't
  // loop indefinitely between Coder and the security gate.
  maxSecurityGateRetries: 2,
} as const;

// ============ RATE LIMITS ============
export const RATE_LIMITS = {
  free: { requestsPerMinute: 5, requestsPerHour: 50 },
  pro: { requestsPerMinute: 30, requestsPerHour: 500 },
  team: { requestsPerMinute: 120, requestsPerHour: 2000 },
  enterprise: { requestsPerMinute: 500, requestsPerHour: 10000 },
} as const;

// ============ CREDIT COSTS ============
export const CREDIT_COSTS = {
  // Per-operation credit deductions
  generation: 10, // per app generation
  research: 5, // per CERL research query
  embedding: 1, // per 1K tokens embedded
  rerank: 1, // per rerank call
  latticeUpdate: 2, // per lattice re-computation
  citation: 0, // free — citations are governance
} as const;

// ============ BILLING (Stripe) ============
// See vault_commercial_launch_plan.md §5/§7 (Phase C) and
// apps/web/src/lib/stripe.ts / routes/billing.ts. Two purchase flows:
//   1. One-time credit packs (Checkout mode: "payment") — the primary gap
//      the plan calls out ("Pay for more credits when the trial ends: not
//      real"); this is what actually converts an expired-trial user.
//   2. Tier subscription upgrades (Checkout mode: "subscription") — `tier`
//      already exists on `users` and gates TIER_LIMITS above, but nothing
//      before this phase could ever move a user off `free` via payment.
//      `free` isn't purchasable (default on signup) and `enterprise` isn't
//      self-serve (contact sales), so only pro/team go through Checkout.
//
// PLACEHOLDER PRICES: no real Stripe account exists yet and these have
// never been checked against real per-request Cohere/OpenRouter costs (see
// CREDIT_COSTS above, and the unit-economics-validation gap this plan
// doesn't close). A human must sanity-check these before going live —
// they're deliberately defined via Stripe's inline `price_data` rather
// than dashboard-created Price IDs, so changing them needs no Stripe
// dashboard access, just an edit here.
export const CREDIT_PACKAGES = {
  test: { credits: 100, priceUsdCents: 100, label: '100 credits — $1 (test)' },
  small: { credits: 500, priceUsdCents: 500, label: '500 credits — $5' },
  medium: {
    credits: 2500,
    priceUsdCents: 2000,
    label: '2,500 credits — $20',
  },
  large: {
    credits: 10000,
    priceUsdCents: 7000,
    label: '10,000 credits — $70',
  },
} as const;
export type CreditPackageId = keyof typeof CREDIT_PACKAGES;

export const TIER_SUBSCRIPTION_PRICES = {
  pro: { priceUsdCents: 2900, label: 'Pro — $29/mo' },
  team: { priceUsdCents: 9900, label: 'Team — $99/mo' },
} as const;
export type PurchasableTier = keyof typeof TIER_SUBSCRIPTION_PRICES;

// ============ GOVERNANCE ============
export const AUTONOMY_DEFAULTS = {
  research: 'L2', // Can recommend, not execute
  generation: 'L3', // Can execute reversible actions
  deployment: 'L4', // Requires controlled execution
  destructive: 'L5', // Requires human approval
} as const;

// ============ LATTICE ============
export const LATTICE_DEFAULTS = {
  embeddingDim: 1536,
  maxNodesPerUser: 5000,
  umapNNeighbors: 15,
  umapMinDist: 0.1,
  umapSpread: 1.0,
  cameraDistance: 50,
  cameraFov: 60,
  nodeSizeMin: 0.5,
  nodeSizeMax: 2.0,
  glowIntensity: 1.5,
  animationDuration: 300, // ms
} as const;

// ============ SESSION ============
export const SESSION_DEFAULTS = {
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  websocketHeartbeatMs: 30 * 1000, // 30 seconds
  maxConcurrentGenerations: 3,
  generationTimeoutMs: 5 * 60 * 1000, // 5 minutes
} as const;

// ============ FEATURE FLAGS ============
export const FEATURES = {
  memoryLattice: true,
  cerlResearch: true,
  governance: true,
  citations: true,
  structuredOutputs: true,
  toolUse: true,
  streaming: true,
  codePreview: true,
  webPreview: true,
  collaboration: false, // Post-MVP
  gitIntegration: false, // Post-MVP
  customModels: false, // Post-MVP
} as const;

// ============ SIMULATION-EVOLVED PARAMETERS (Butterfly v7) ============
// These values were proven optimal by Monte Carlo evolutionary simulation
// (10.24M interactions, 53 genes mutated from baseline).
// See simulation/butterfly_v7_report.json for the full genome.
// Do NOT manually adjust without re-running the simulation.
export const SIM_EVOLVED = {
  // Pipeline
  pipelineMode: 'parallel' as const,
  feedbackLoopDepth: 4,
  agentCount: 2,
  agentTimeoutSeconds: 142,
  conversationTurnLimit: 15,

  // VDR knobs
  earlyExitThreshold: 16,
  tripwireSensitivity: 4,
  deploymentGateScore: 0.611,
  retryLimit: 4,
  perUserBudget: 238,
  perBotBudget: 67,
  burnRatePerMin: 27,

  // Discovery
  researchDepth: 5,
  contextWindowUtilization: 0.356,
  rerankDepth: 78,
  embeddingDimensions: 1536,
  latticeSearchRadius: 3,

  // Model
  modelTemperature: 0.676,
  primaryModel: 'mixed' as const,

  // UI/UX
  responsiveBreakpointPx: 500,
  contentDensity: 0.316,
  accessibilityLevel: 'WCAG-AAA' as const,
  uiInteractionMode: 'multi-modal' as const,
  inputBandwidth: 'full-multimodal' as const,
  responseFormat: 'hybrid' as const,
  approvalFlow: 'progressive-disclosure' as const,
  errorRecovery: 'human-handoff' as const,
  onboardingDepth: 'interactive-tutorial' as const,
  voiceVideoEnabled: true,
  typingIndicators: true,

  // Collaboration
  teamSessionMax: 40,
  collabPersistence: 'postgres' as const,

  // Enterprise
  auditLogRetentionDays: 6,
  multiTenantIsolation: 'schema-per-tenant' as const,

  // Billing
  billingModel: 'usage-based' as const,
  nonprofitDiscount: 94,
  teamBillingModel: 'nonprofit-free' as const,
  teamPermissions: 'comment' as const,

  // Proactive detection
  healthScoreEnabled: true,
  churnPredictionModel: 'heuristic' as const,
  usageAnomalyDetection: 'ml' as const,
  sentimentAnalysisSource: 'support-tickets' as const,
  earlyWarningThreshold: 0.3,
  autoIntervention: 'auto-credit' as const,

  // Value guarantee
  valueGuarantee: 'credit-back' as const,
  creditRefundPolicy: 'eicca' as const,

  // Tripwire thresholds
  tw_empty_generation_streak: 3,
  tw_infinite_loop_detection: 4,
  tw_credit_burn_warning: 39,
  tw_approval_bypass_attempts: 2,
  tw_token_overflow_limit: 89435,
  tw_duplicate_generation_limit: 4,
  tw_timeout_seconds: 91,
  tw_unauthorized_attempt_limit: 2,
} as const;

// ============ FEATURE FLAGS (from simulation-evolved genome) ============
export const FEATURE_FLAGS = {
  voiceVideoEnabled: true, // Butterfly v7: voice_video_enabled
  collabPersistence: 'postgres' as const, // Butterfly v7: collab_persistence
  // These are architectural goals — implementation phased
  // voice/video: feature flag ready, UI components TBD
  // collab persistence: D1-backed currently, postgres migration planned
} as const;

// ============ GENOME SOURCE OF TRUTH (Production Hierarchy) ============
// The production site (discomplemented.com / COMPaNiON repo) is the
// authoritative source for the genome count. All other environments
// (admin repo, staging, Monte Carlo) must derive their parameters
// from these constants via the /api/genome/status endpoint.
//
// HIERARCHY: Production > Staging > Admin/Evolution
// If production changes (e.g. a PR merge adds genes), staging and admin
// must auto-adapt by reading the /api/genome/status endpoint.
//
// 11x POPULATION RULE (Storn & Price, 10x genome benchmark):
// - Weekly Monte Carlo population = GENOME_COUNT * POPULATION_MULTIPLIER
// - Daily staging bots = GENOME_COUNT (1 bot per genome, verifies each gene)
// - Currently: 97 genes, 97 daily bots, 1067 weekly Monte Carlo population

export const GENOME_COUNT = 97; // Butterfly v8: 97 genes across 4 supergenes
export const POPULATION_MULTIPLIER = 11; // Storn & Price benchmark (10x + 10% safety)
export const MONTE_CARLO_POPULATION = GENOME_COUNT * POPULATION_MULTIPLIER; // 1067
export const DAILY_STAGING_BOTS = GENOME_COUNT; // 97 (1 per genome)
export const GENERATION_COUNT = 100; // Monte Carlo generations per cycle
export const MUTATION_RATE = 0.05; // 5% — prevents premature convergence (Goldberg/Schlatterbeck)
export const ELITISM_PERCENT = 10; // Top 10% preserved each generation
export const DIVERSITY_THRESHOLD = 20; // 20% diversity floor

// Synchronized random seed for Monte Carlo + staging (Glassbox_Labs deterministic)
// Same seed + same DNA = identical VDR and Merkle root (see deterministic-prng.ts)
export const SIM_SEED = 0xb1cc4f00d; // Butterfly seed — never change without full re-run

// ============ DERIVED CONSTANTS (auto-adapt when GENOME_COUNT changes) ============
// These replace all hardcoded population/bot numbers across the codebase.
// Any code that needs population sizes should import these instead of using
// static numbers.
export const SIMULATION_PARAMS = {
  genomeCount: GENOME_COUNT,
  population: MONTE_CARLO_POPULATION,
  dailyBots: DAILY_STAGING_BOTS,
  generations: GENERATION_COUNT,
  mutationRate: MUTATION_RATE,
  elitism: ELITISM_PERCENT,
  diversity: DIVERSITY_THRESHOLD,
  seed: SIM_SEED,
  // 1:1:1 parity — all three layers use the same genome and seed
  // ~1 Monte Carlo: 11x population, time-unbound, $0
  // ~2 Staging: 1x population (1 bot per gene), time-bound, small cost
  // ~3 Production: reads from ~1 + ~2, maintains VDR
  parity: '1:1:1' as const,
  // Sync check interval (production monitor checks every 5 minutes)
  syncCheckIntervalSeconds: 300,
} as const;

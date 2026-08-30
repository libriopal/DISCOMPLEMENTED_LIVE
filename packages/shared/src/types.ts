/**
 * @bicameral/shared — Core domain types
 * Single source of truth for all types used across the monorepo.
 * Changes here propagate to both public and private packages via pnpm workspaces.
 */

// ============ USER & AUTH ============
export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  tier: SubscriptionTier;
  credits: number;
  createdAt: string;
  updatedAt: string;
}

export type UserRole = 'user' | 'admin' | 'owner';
export type SubscriptionTier = 'free' | 'pro' | 'team' | 'enterprise';

// ============ ADMIN ============
// Stored on users.admin_level (nullable — null means no admin access).
// See @agent_docs/admin-panel.md "Permission Tiers".
export type AdminPermissionLevel = '-read' | '-write' | '-full';

const ADMIN_PERMISSION_LEVELS: readonly AdminPermissionLevel[] = [
  '-read',
  '-write',
  '-full',
];

/** Runtime guard for values coming from outside the type system — the
 * admin_level column (Better Auth's additionalFields only support `type:
 * 'string'`, so the session loses the literal union) and PATCH request
 * bodies. Used on both the read side (Sidebar/AdminView casting the
 * session user) and the write side (routes/admin.ts validating a PATCH
 * body) so a malformed value fails closed instead of silently corrupting
 * either side. */
export function isAdminPermissionLevel(
  value: unknown
): value is AdminPermissionLevel {
  return (
    typeof value === 'string' &&
    (ADMIN_PERMISSION_LEVELS as readonly string[]).includes(value)
  );
}

// ============ SUBSCRIPTION ============
export interface Subscription {
  id: string;
  userId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodEnd: string;
  creditsRemaining: number;
  creditsTotal: number;
}

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trialing'
  | 'paused';

// ============ CREDITS ============
export interface CreditLedgerEntry {
  id: string;
  userId: string;
  amount: number; // positive = credit, negative = debit
  reason: CreditReason;
  refId: string | null;
  balanceAfter: number;
  createdAt: string;
}

export type CreditReason =
  | 'subscription'
  | 'purchase'
  | 'generation'
  | 'research'
  | 'refund'
  | 'bonus'
  | 'reset';

// ============ COHERE MODELS ============
export interface CohereModelConfig {
  modelId: string;
  displayName: string;
  maxTokens: number;
  contextWindow: number;
  tierRequired: SubscriptionTier;
  costPer1KInput: number;
  costPer1KOutput: number;
  capabilities: CohereCapability[];
}

export type CohereCapability =
  | 'chat'
  | 'tool_use'
  | 'structured_output'
  | 'citations'
  | 'reasoning'
  | 'streaming';

export interface CohereModelMap {
  free: string;
  pro: string;
  team: string;
  enterprise: string;
  reasoning: string;
  embed: string;
  rerankPro: string;
  rerankFast: string;
}

// ============ GENERATION ============
export interface GenerationSession {
  id: string;
  userId: string;
  prompt: string;
  templateId: string | null;
  status: GenerationStatus;
  modelUsed: string;
  creditsCost: number;
  output: GeneratedProject | null;
  createdAt: string;
  completedAt: string | null;
}

export type GenerationStatus =
  | 'queued'
  | 'planning'
  | 'generating'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GeneratedProject {
  id: string;
  name: string;
  files: ProjectFile[];
  framework: string;
  dependencies: Record<string, string>;
  previewUrl: string | null;
}

export interface ProjectFile {
  path: string;
  content: string;
  language: string;
}

// ============ MEMORY LATTICE ============
export interface LatticeNode {
  id: string;
  type: LatticeNodeType;
  hemisphere: Hemisphere;
  label: string;
  confidence: number;
  density: number;
  position: [number, number, number];
  embedding: number[] | null;
  clusterId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LatticeNodeType =
  | 'semantic'
  | 'requirement'
  | 'bridge'
  | 'architecture'
  | 'code'
  | 'cluster';
export type Hemisphere = 'left' | 'right' | 'bridge';

export interface LatticeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  weight: number;
  createdAt: string;
}

export type EdgeType =
  | 'depends'
  | 'implements'
  | 'references'
  | 'contradicts'
  | 'aligns'
  | 'derives';

// ============ RESEARCH (CERL) ============
export interface EvidenceRecord {
  id: string;
  sourceType: SourceType;
  sourceUrl: string;
  title: string;
  authors: string[];
  publicationDate: string | null;
  retrievalDate: string;
  documentType: string;
  doi: string | null;
  abstract: string;
  content: string;
  contentHash: string;
  sourceAuthority: SourceAuthority;
  sourceReliability: number;
  researchDomain: string;
  claims: ClaimRecord[];
  embeddingRef: string | null;
  rerankScore: number;
  verificationStatus: VerificationStatus;
  limitations: string;
  accessStatus: AccessStatus;
}

export type SourceType =
  | 'web'
  | 'scholarly'
  | 'api_docs'
  | 'vendor_docs'
  | 'standard'
  | 'book'
  | 'dataset';
export type SourceAuthority = 'tier0' | 'tier1' | 'tier2' | 'tier3';
export type VerificationStatus =
  | 'unverified'
  | 'partially_verified'
  | 'verified'
  | 'contradicted'
  | 'stale'
  | 'inconclusive'
  | 'unavailable';
export type AccessStatus =
  | 'open'
  | 'paywalled'
  | 'restricted'
  | 'failed'
  | 'unavailable';

export interface ClaimRecord {
  claimId: string;
  claimText: string;
  claimType: string;
  sourceIds: string[];
  supportingEvidence: string[];
  contradictingEvidence: string[];
  confidence: number;
  verificationStatus: VerificationStatus;
  dateVerified: string | null;
  verifiedBy: string;
  architecturalImpact: string;
}

export interface ContradictionRecord {
  contradictionId: string;
  claimA: string;
  claimB: string;
  sourceA: string;
  sourceB: string;
  reason: string;
  possibleResolution: string;
  resolutionStatus: 'open' | 'resolved' | 'unresolvable';
  architecturalImpact: string;
  humanDecisionRequired: boolean;
}

// ============ GOVERNANCE ============
export interface ApprovalGate {
  gateId: string;
  type: GateType;
  description: string;
  autonomyLevel: AutonomyLevel;
  requiredApprover: UserRole;
  status: GateStatus;
  evidenceRefs: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export type GateType =
  | 'blueprint'
  | 'deployment'
  | 'model_change'
  | 'data_export'
  | 'destructive'
  | 'research_freeze';
export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type GateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'auto_resolved';

// ============ PIPELINE (4-Agent: Architect -> Researcher -> Designer -> Coder) ============
export type AgentRole =
  | 'architect' // legacy — merged into researcher Aug 21 2026
  | 'researcher'
  | 'auditor'
  | 'verifier'
  | 'designer'
  | 'coder';

export type PipelineStatus =
  | 'idle'
  | 'ideating' // legacy — now 'researching'
  | 'researching'
  | 'auditing'
  | 'verifying'
  | 'designing'
  | 'awaiting_approval'
  | 'implementing'
  | 'scanning'
  | 'deployed'
  | 'error'
  | 'paused';

/**
 * Execution mode controls how the pipeline handles inter-agent gates.
 *
 * There used to be a third variant, `dangerously_automated`, commented here as
 * "auto-advance, no safety pauses, no logging". It never did any of that.
 * `shouldPauseAtGate` in GenerationOrchestrator is the whole gate decision and
 * reads `mode === 'ask_first'`, so every non-ask_first mode behaved
 * identically — the name promised extra automation it did not have and a
 * logging change it did not make, in both directions.
 *
 * It was deleted rather than implemented. The only behaviour it promised
 * beyond `auto_accept` was suppressing the log, and a pipeline that automates
 * itself without a record is one no audit can reconstruct afterwards — which
 * is the opposite of what the audit trail exists for. `auto_accept` already
 * covers "advance without asking me", with the record intact.
 *
 * Runs persisted before the deletion may still carry the old string.
 * `normalizeExecutionMode` maps it to `auto_accept`, which is what those runs
 * actually did.
 */
export type ExecutionMode =
  | 'ask_first' // pause at every gate, require user approval
  | 'auto_accept'; // auto-advance through gates, log everything

/** The variant that was removed. Persisted rows may still hold it. */
export const RETIRED_EXECUTION_MODE = 'dangerously_automated';

/**
 * Coerce a stored or client-supplied mode to a live one.
 *
 * The retired variant maps to `auto_accept` rather than `ask_first`: those runs
 * auto-advanced in practice, so that is the honest translation, and sending an
 * in-flight run back to a gate would leave it waiting on an approval nobody
 * knows to give. Anything unrecognised falls to `ask_first`, because an unknown
 * mode is not a reason to stop asking.
 */
export function normalizeExecutionMode(
  mode: string | null | undefined
): ExecutionMode {
  if (mode === 'auto_accept' || mode === RETIRED_EXECUTION_MODE)
    return 'auto_accept';
  return 'ask_first';
}

/** Gate state for inter-agent hand-offs in the 5-agent consensus pipeline. */
export interface AgentGate {
  step: AgentRole;
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
  message?: string; // hand-off message from the previous agent
  userFeedback?: string; // user's edit/mutation of the message
  retryCount: number;
  createdAt: string;
  resolvedAt?: string;
}

/** Group chat message from an agent in the consensus pipeline. */
export interface AgentMessage {
  id: string;
  pipelineRunId: string;
  step: AgentRole;
  /** `tool` records that the pipeline invoked one of `pipeline/tools/` — a
   * direct call from agent code, not a model-issued tool call. The agents make
   * none of the latter; see lib/tool-record.ts for why that distinction is
   * worth keeping in the name. */
  messageType: 'reasoning' | 'output' | 'consensus' | 'error' | 'gate' | 'tool';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type PipelineStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export type PipelineEventType =
  | 'step:start'
  | 'step:progress'
  | 'step:complete'
  | 'gate:awaiting_approval'
  | 'iteration:complete'
  | 'pipeline:complete'
  | 'pipeline:error';

// Step 1 (Architect) output — matches the generate_project_brief tool schema
export interface ProjectBrief {
  appName: string;
  appType: 'web' | 'mobile' | 'fullstack';
  targetUsers: string;
  coreFeatures: string[];
  dataModels: DataModel[];
  techPreferences: string;
  complexity: 'simple' | 'moderate' | 'complex';
  estimatedComponents: number;
}

export interface DataModel {
  name: string;
  fields: string[];
}

// Step 2 (Researcher) output — matches the submit_research tool
export interface ResearchFindings {
  techStack: TechStackRecommendation[];
  similarProjects: SimilarProject[];
  risks: ResearchRisk[];
  recommendedLibraries: string[];
  evidenceRefs: string[]; // EvidenceRecord.id references
}

export interface TechStackRecommendation {
  category: string;
  recommendation: string;
  rationale: string;
}

export interface SimilarProject {
  name: string;
  description: string;
  relevantPatterns: string[];
}

export interface ResearchRisk {
  description: string;
  severity: 'low' | 'medium' | 'high';
  mitigation: string;
}

// Step 3 (Designer) output — matches the generate_blueprint tool schema
export interface SystemBlueprint {
  components: BlueprintComponent[];
  database: BlueprintDatabase;
  apiRoutes: BlueprintApiRoute[];
  authStrategy: string;
  envVars: string[];
  deployConfig: Record<string, unknown>;
}

export interface BlueprintComponent {
  path: string;
  type: 'page' | 'component' | 'api' | 'util' | 'schema' | 'config';
  description: string;
  dependencies: string[];
}

export interface BlueprintDatabase {
  tables: unknown[];
  relationships: unknown[];
}

export interface BlueprintApiRoute {
  path: string;
  method: string;
  description: string;
}

// Step 4 (Coder) — human gate between Design and Implementation
export interface BlueprintApproval {
  approved: boolean;
  feedback: string | null;
}

// Top-level pipeline run — orchestrated by the GenerationOrchestrator DO
export interface PipelineRun {
  id: string;
  userId: string;
  projectId: string | null;
  status: PipelineStatus;
  currentStep: AgentRole | null;
  brief: ProjectBrief | null;
  research: ResearchFindings | null;
  blueprintId: string | null;
  deploymentUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// Per-agent execution record — one row per step attempt
export interface PipelineStepRecord {
  id: string;
  pipelineRunId: string;
  step: AgentRole;
  status: PipelineStepStatus;
  model: string;
  iteration: number;
  tokensUsed: number;
  durationMs: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ============ AUDIT LOG ============
export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  resource: string;
  resourceId: string | null;
  timestamp: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  evidenceRefs: string[];
  approvalState: string | null;
  metadata: Record<string, unknown>;
}

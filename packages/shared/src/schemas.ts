/**
 * @bicameral/shared — Zod schemas for runtime validation
 * Mirrors the types in types.ts with Zod for request/response validation
 */
import { z } from 'zod';

// Field-specific normalization for LLM-output enum fields. Models don't
// reliably honor exact casing OR exact synonyms even when the prompt
// spells them out. Each normalizer maps common synonyms to the exact
// enum values expected by that specific field — a global synonym map
// doesn't work because "moderate" and "medium" are synonyms but mean
// different things in different fields (severity uses "medium",
// complexity uses "moderate").
//
// This is the #1 fix for the pipeline dying on synonym mismatch —
// "moderate" vs "medium" killed the Researcher step, and "medium" vs
// "moderate" killed the Architect step. Both are now normalized.

function normalizeSeverity(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const map: Record<string, string> = {
    moderate: 'medium',
    critical: 'high',
    severe: 'high',
    major: 'high',
    significant: 'high',
    minor: 'low',
    trivial: 'low',
    negligible: 'low',
  };
  return map[val.toLowerCase().trim()] ?? val.toLowerCase().trim();
}

function normalizeComplexity(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const map: Record<string, string> = {
    medium: 'moderate',
    easy: 'simple',
    basic: 'simple',
    intermediate: 'moderate',
    hard: 'complex',
    advanced: 'complex',
    difficult: 'complex',
  };
  return map[val.toLowerCase().trim()] ?? val.toLowerCase().trim();
}

function normalizeAppType(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const map: Record<string, string> = {
    frontend: 'web',
    backend: 'fullstack',
    desktop: 'web',
    spa: 'web',
    pwa: 'web',
  };
  return map[val.toLowerCase().trim()] ?? val.toLowerCase().trim();
}

function normalizeComponentType(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const map: Record<string, string> = {
    route: 'api',
    endpoint: 'api',
    utility: 'util',
    helper: 'util',
    configuration: 'config',
    settings: 'config',
    module: 'component',
  };
  return map[val.toLowerCase().trim()] ?? val.toLowerCase().trim();
}

// Generic lowercase for backward compat
function lowercaseString(val: unknown): unknown {
  return typeof val === 'string' ? val.toLowerCase().trim() : val;
}

// ============ AUTH ============
export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string().min(1),
  role: z.enum(['user', 'admin', 'owner']),
  tier: z.enum(['free', 'pro', 'team', 'enterprise']),
  credits: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const subscriptionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  tier: z.enum(['free', 'pro', 'team', 'enterprise']),
  status: z.enum(['active', 'past_due', 'canceled', 'trialing', 'paused']),
  stripeCustomerId: z.string(),
  stripeSubscriptionId: z.string(),
  currentPeriodEnd: z.string().datetime(),
  creditsRemaining: z.number().int().nonnegative(),
  creditsTotal: z.number().int().positive(),
});

// ============ GENERATION ============
export const generationRequestSchema = z.object({
  prompt: z.string().min(1).max(10000),
  templateId: z.string().uuid().optional(),
  modelOverride: z.string().optional(),
  options: z
    .object({
      framework: z.enum(['react', 'next', 'vite', 'astro']).optional(),
      styling: z.enum(['tailwind', 'unocss', 'css', 'styled']).optional(),
      typescript: z.boolean().default(true),
      responsive: z.boolean().default(true),
    })
    .partial()
    .optional(),
});

export const generationStatusSchema = z.enum([
  'queued',
  'planning',
  'generating',
  'streaming',
  'completed',
  'failed',
  'cancelled',
]);

// ============ COHERE ============
export const cohereModelMapSchema = z.object({
  free: z.string(),
  pro: z.string(),
  team: z.string(),
  enterprise: z.string(),
  reasoning: z.string(),
  embed: z.string(),
  rerankPro: z.string(),
  rerankFast: z.string(),
});

export const cohereChatRequestSchema = z.object({
  model: z.string(),
  message: z.string(),
  conversationId: z.string().optional(),
  preamble: z.string().optional(),
  tools: z.array(z.any()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(32768).optional(),
  stream: z.boolean().default(false),
  // Renamed from `citationQuality`: it was sent as the v1 `citation_quality`
  // field, which v2 rejects with HTTP 422. See ChatRequest.citationMode —
  // 'accurate' 400s on every model this repo dispatches.
  citationMode: z.enum(['fast', 'accurate']).optional(),
});

// ============ LATTICE ============
export const latticeNodeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    'semantic',
    'requirement',
    'bridge',
    'architecture',
    'code',
    'cluster',
  ]),
  hemisphere: z.enum(['left', 'right', 'bridge']),
  label: z.string(),
  confidence: z.number().min(0).max(1),
  density: z.number().min(0).max(1),
  position: z.tuple([z.number(), z.number(), z.number()]),
  clusterId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ============ RESEARCH ============
export const evidenceRecordSchema = z.object({
  id: z.string().uuid(),
  sourceType: z.enum([
    'web',
    'scholarly',
    'api_docs',
    'vendor_docs',
    'standard',
    'book',
    'dataset',
  ]),
  sourceUrl: z.string().url(),
  title: z.string(),
  authors: z.array(z.string()),
  retrievalDate: z.string().datetime(),
  verificationStatus: z.enum([
    'unverified',
    'partially_verified',
    'verified',
    'contradicted',
    'stale',
    'inconclusive',
    'unavailable',
  ]),
  sourceAuthority: z.enum(['tier0', 'tier1', 'tier2', 'tier3']),
  rerankScore: z.number().min(0).max(1),
});

// ============ PIPELINE ============
export const agentRoleSchema = z.enum([
  'architect',
  'researcher',
  'designer',
  'coder',
]);

export const pipelineStatusSchema = z.enum([
  'idle',
  'ideating',
  'researching',
  'designing',
  'awaiting_approval',
  'implementing',
  'deployed',
  'error',
  'paused',
]);

export const pipelineStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
]);

export const dataModelSchema = z.object({
  name: z.string(),
  fields: z.array(z.string()),
});

export const projectBriefSchema = z.object({
  appName: z.string().min(1),
  appType: z.preprocess(
    normalizeAppType,
    z.enum(['web', 'mobile', 'fullstack'])
  ),
  targetUsers: z.string(),
  coreFeatures: z.array(z.string()).min(1),
  dataModels: z.array(dataModelSchema).min(1),
  techPreferences: z.string(),
  complexity: z.preprocess(
    normalizeComplexity,
    z.enum(['simple', 'moderate', 'complex'])
  ),
  estimatedComponents: z.number().int().nonnegative(),
});

export const researchFindingsSchema = z.object({
  techStack: z.array(
    z.object({
      category: z.string(),
      recommendation: z.string(),
      rationale: z.string(),
    })
  ),
  similarProjects: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      relevantPatterns: z.array(z.string()),
    })
  ),
  risks: z.array(
    z.object({
      description: z.string(),
      severity: z.preprocess(
        normalizeSeverity,
        z.enum(['low', 'medium', 'high'])
      ),
      mitigation: z.string(),
    })
  ),
  recommendedLibraries: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
});

export const systemBlueprintSchema = z.object({
  components: z.preprocess(
    (val) => {
      // Filter out non-object entries — LLMs sometimes put strings in arrays
      if (!Array.isArray(val)) return [];
      return val.filter(
        (item) =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
      );
    },
    z.array(
      z.object({
        path: z.string(),
        type: z.preprocess(
          normalizeComponentType,
          z.enum(['page', 'component', 'api', 'util', 'schema', 'config'])
        ),
        description: z.string(),
        dependencies: z.array(z.string()),
      })
    )
  ),
  database: z.object({
    tables: z.array(z.unknown()),
    relationships: z.array(z.unknown()),
  }),
  apiRoutes: z.array(
    z.object({
      path: z.string(),
      method: z.string(),
      description: z.string(),
    })
  ),
  authStrategy: z.string(),
  envVars: z.array(z.string()),
  deployConfig: z.record(z.string(), z.unknown()),
});

export const blueprintApprovalSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().nullable(),
});

export const pipelineRunSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  status: pipelineStatusSchema,
  currentStep: agentRoleSchema.nullable(),
  brief: projectBriefSchema.nullable(),
  research: researchFindingsSchema.nullable(),
  blueprintId: z.string().uuid().nullable(),
  deploymentUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ============ GOVERNANCE ============
export const approvalGateSchema = z.object({
  gateId: z.string().uuid(),
  type: z.enum([
    'blueprint',
    'deployment',
    'model_change',
    'data_export',
    'destructive',
    'research_freeze',
  ]),
  description: z.string(),
  autonomyLevel: z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']),
  requiredApprover: z.enum(['user', 'admin', 'owner']),
  status: z.enum([
    'pending',
    'approved',
    'rejected',
    'expired',
    'auto_resolved',
  ]),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedBy: z.string().nullable(),
});

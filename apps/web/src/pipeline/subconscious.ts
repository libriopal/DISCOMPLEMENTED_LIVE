/**
 * Subconscious Layer — Pre-reasoning context injection for all 5 agents.
 *
 * ARCHITECTURE — The Three Memory Layers:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  GEOMETRIC SEMANTIC CLOUD (Subconscious / Long-term)     │
 *   │  Embed v4 → Vectorize + Geometric Cloud Topology         │
 *   │  Seeded PRNG → cluster centers (brain regions)           │
 *   │  Rerank v4 = attention mechanism (lights up regions)     │
 *   │  North Mini Code = intuition (reasoning DISABLED)         │
 *   │                                                          │
 *   │  Diffuse, all points accessible, no deep reasoning        │
 *   └───────────────────────┬─────────────────────────────────┘
 *                           │ centroid query
 *   ┌───────────────────────▼─────────────────────────────────┐
 *   │  CONSCIOUSNESS LAYER (Conscious / Short-term)            │
 *   │  Current conversation → semantic poetry compression      │
 *   │  Working memory (recent messages) + compressed blocks     │
 *   │  Centroid → bridges to subconscious cloud                 │
 *   │                                                           │
 *   │  Focused, current, managed context window                │
 *   └───────────────────────┬─────────────────────────────────┘
 *                           │ awareness + intuition
 *   ┌───────────────────────▼─────────────────────────────────┐
 *   │  CONSCIOUS REASONING (Thinking / Active)                  │
 *   │  Command A+ / Command A Reasoning with thinking enabled  │
 *   │  Pre-reasoning context injection (grounded, before think)│
 *   │  The agent's thoughts are the conscious processing       │
 *   │                                                           │
 *   │  Condensed, ordered, deeply reasoned                      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * This module implements the full pipeline:
 *   1. Generate cloud topology from seed (geometric-cloud.ts)
 *   2. Retrieve similar patterns from the lattice (lattice-enrich.ts)
 *   3. Rerank patterns by relevance (Cohere Rerank v4)
 *   4. Generate intuition from patterns (North Mini Code, reasoning disabled)
 *   5. Inject awareness from consciousness layer (consciousness.ts)
 *   6. Build the context block for the agent's prompt
 *
 * Enterprise pipeline: full subconscious + consciousness + reasoning on all agents
 * Free/Pro pipeline: lattice access only (Layers 1-2), no rerank or intuition
 */
import { rerank } from '@bicameral/cohere/rerank';
import { COHERE_MODELS, SIM_EVOLVED } from '@bicameral/shared/constants';
import type { SimilarPattern } from './lattice-enrich.js';
import {
  generateCloudTopology,
  generateClusterCenters,
  routeToBrainRegions,
  cloudFingerprint,
  type CloudTopologyParams,
  type ClusterCenter,
} from './geometric-cloud.js';
import type { ConsciousnessState } from './consciousness.js';
import type { Env } from '../env.js';

export interface SubconsciousInput {
  /** The agent's task query — e.g. "Build a todo app with React" */
  query: string;
  /** Retrieved similar patterns from the lattice */
  patterns: SimilarPattern[];
  /** Agent role — determines which brain regions to activate */
  agentRole: 'researcher' | 'auditor' | 'verifier' | 'designer' | 'coder';
  /** Subscription tier — enterprise gets full subconscious, others get rerank-only */
  tier: 'free' | 'pro' | 'team' | 'enterprise';
  /** Project ID for cloud topology seed */
  projectId?: string | null;
  /** Task complexity for cloud topology */
  complexity?: 'simple' | 'moderate' | 'complex';
  /** Consciousness state — current conversation awareness */
  consciousness?: ConsciousnessState;
  /** Env for Cohere API access */
  env: Env;
}

export interface SubconsciousOutput {
  /** Reranked patterns (top N after cross-encoder scoring) */
  rerankedPatterns: SimilarPattern[];
  /** North Mini Code "intuition" — a concise hunch from the patterns */
  intuition: string;
  /** Cloud topology params for this run */
  cloudParams: CloudTopologyParams | null;
  /** Cloud fingerprint — identifies the cloud structure */
  cloudFingerprint: string | null;
  /** Brain regions activated for this agent */
  activatedRegions: number[] | null;
  /** Awareness from consciousness layer (current conversation memory) */
  awareness: string;
  /** Formatted block to inject into the agent's prompt */
  contextBlock: string;
  /** Whether the full subconscious (intuition) was used or just rerank */
  fullSubconscious: boolean;
}

// Rerank model selection: Pro for quality gates, Fast for everything else
const RERANK_MODEL_BY_AGENT: Record<string, string> = {
  auditor: COHERE_MODELS.rerankPro,
  verifier: COHERE_MODELS.rerankPro,
  researcher: COHERE_MODELS.rerankFast,
  designer: COHERE_MODELS.rerankFast,
  coder: COHERE_MODELS.rerankFast,
};

/**
 * Run the full subconscious layer: Cloud topology + Rerank + Intuition + Awareness.
 *
 * For enterprise tier: full subconscious (cloud + rerank + intuition + awareness)
 * For other tiers: Rerank only (no intuition layer — saves API calls)
 *
 * Best-effort: if any layer fails, fall back gracefully.
 */
export async function runSubconscious(
  input: SubconsciousInput
): Promise<SubconsciousOutput> {
  const {
    query,
    patterns,
    agentRole,
    tier,
    projectId,
    complexity,
    consciousness,
    env,
  } = input;

  // No patterns and no consciousness → no subconscious needed
  if (patterns.length === 0 && !consciousness) {
    return {
      rerankedPatterns: [],
      intuition: '',
      cloudParams: null,
      cloudFingerprint: null,
      activatedRegions: null,
      awareness: '',
      contextBlock: '',
      fullSubconscious: false,
    };
  }

  // Layer 1: Generate cloud topology (enterprise only — it's deterministic, no API cost)
  let cloudParams: CloudTopologyParams | null = null;
  let cloudFp: string | null = null;
  let activatedRegions: number[] | null = null;

  if (tier === 'enterprise' && projectId !== undefined) {
    const seed = projectId ?? 'global';
    const taskType = query.slice(0, 100);
    cloudParams = generateCloudTopology(seed, complexity ?? 'moderate');
    cloudFp = cloudFingerprint(seed, cloudParams);

    // Generate brain regions and route this agent to the right ones
    try {
      const centers = generateClusterCenters(seed, cloudParams);
      activatedRegions = routeToBrainRegions(agentRole, centers, 3);
    } catch {
      // Cloud topology generation failed — non-fatal
    }
  }

  // Layer 2: Rerank patterns by relevance to THIS specific query
  let rerankedPatterns = patterns;
  try {
    if (patterns.length > 0) {
      const rerankModel =
        RERANK_MODEL_BY_AGENT[agentRole] ?? COHERE_MODELS.rerankFast;
      const documents = patterns.map(
        (p) => `${p.label}${p.content ? `: ${p.content.slice(0, 2000)}` : ''}`
      );

      const rerankResponse = await rerank(
        {
          model: rerankModel,
          query: query.slice(0, 4000),
          documents,
          topN: Math.min(patterns.length, 5),
          returnDocuments: false,
        },
        {
          COHERE_API_KEY: env.COHERE_API_KEY,
          COHERE_API_BASE: env.COHERE_BASE_URL,
        }
      );

      rerankedPatterns = rerankResponse.data.results
        .filter((r) => r.relevanceScore >= 0.65)
        .map((r) => ({
          ...patterns[r.index],
          score: r.relevanceScore,
        }));
    }
  } catch {
    // Rerank failed — fall back to raw lattice patterns
  }

  // Layer 3: Get awareness from consciousness layer (current conversation)
  let awareness = '';
  if (consciousness) {
    const { getAwareness } = await import('./consciousness.js');
    awareness = getAwareness(consciousness);
  }

  // Layer 4: Intuition — REMOVED per confirmed decision
  // North Mini Code intuition layer was removed. Rerank scores + track record
  // weighting now serve as the intuition signal without an intermediate LLM.
  // This eliminates: API cost, timeout risk, and content-shape bugs.
  const fullSubconscious = tier === 'enterprise';
  const intuition = '';

  // Build the context block to inject into the agent's prompt
  const contextBlock = buildContextBlock(
    rerankedPatterns,
    intuition,
    awareness,
    fullSubconscious,
    cloudFp,
    activatedRegions
  );

  return {
    rerankedPatterns,
    intuition,
    cloudParams,
    cloudFingerprint: cloudFp,
    activatedRegions,
    awareness,
    contextBlock,
    fullSubconscious,
  };
}

/**
 * Build the prompt context block from all layers.
 * Injected BEFORE the agent's thinking block (pre-reasoning context injection).
 *
 * Structure:
 *   1. Cloud fingerprint (which cloud topology is active)
 *   2. Activated brain regions (which parts of the cloud are "lit up")
 *   3. Subconscious intuition (North Mini Code hunch)
 *   4. Conversation awareness (semantic poetry + working memory)
 *   5. Similar past patterns (reranked, for direct reference)
 */
function buildContextBlock(
  patterns: SimilarPattern[],
  intuition: string,
  awareness: string,
  fullSubconscious: boolean,
  cloudFp: string | null,
  activatedRegions: number[] | null
): string {
  const parts: string[] = [];

  // Cloud topology indicator (enterprise only)
  if (cloudFp) {
    parts.push(
      `☁️ CLOUD: ${cloudFp}${activatedRegions ? ` | regions: [${activatedRegions.join(',')}]` : ''}`
    );
  }

  // Subconscious intuition (North Mini Code)
  if (fullSubconscious && intuition) {
    parts.push(
      `🧠 SUBCONSCIOUS INTUITION (from ${patterns.length} past patterns):\n${intuition}`
    );
  }

  // Consciousness awareness (current conversation)
  if (awareness) {
    parts.push(`💭 CONSCIOUSNESS (current conversation memory):\n${awareness}`);
  }

  // Similar past patterns (for direct reference)
  if (patterns.length > 0) {
    const patternList = patterns
      .slice(0, 3)
      .map(
        (p) => `- ${p.label}${p.content ? `: ${p.content.slice(0, 500)}` : ''}`
      )
      .join('\n');
    parts.push(
      `Similar past patterns (for context — adapt, don't copy verbatim):\n${patternList}`
    );
  }

  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}

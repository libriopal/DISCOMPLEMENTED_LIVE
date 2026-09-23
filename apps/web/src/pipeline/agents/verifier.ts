/**
 * Agent 3 — Verifier (Context & Dependency Verification). Verifies that:
 *   1. Model context limits can handle the proposed architecture
 *   2. External dependencies (APIs, libraries) exist and are documented
 *   3. The proposed tech stack is viable for the complexity level
 * Uses You.com search to verify external dependencies are real and current.
 *
 * Runs after the Auditor, before the Designer. The Verifier's output
 * feeds into the Designer as constraints — the Designer must not propose
 * components that the Verifier has flagged as unviable.
 *
 * Schema failures retry with the validation error fed back, up to MAX_RETRIES
 * times — the same loop as designer.ts and auditor.ts. All three used to throw
 * on the first `safeParse` miss; the Auditor was measured doing exactly that in
 * production on 2026-08-28 (`findings[3] Expected object, received number`),
 * killing the run at step 2. Nothing about that failure was specific to the
 * Auditor's schema, so this one gets the same treatment rather than waiting to
 * be the next one measured.
 */
import { z } from 'zod';
import { GenerationError } from '@bicameral/shared/errors';
import type {
  ProjectBrief,
  ResearchFindings,
  SubscriptionTier,
} from '@bicameral/shared';
import type { ChatMessage } from '@bicameral/cohere/chat';
import { callAgentModel, selectModel } from '../../lib/cohere.js';
import { verifyDependency } from '../../lib/youcom-research.js';
import { findSimilarPatterns } from '../lattice-enrich.js';
import { runSubconscious } from '../subconscious.js';
import type { Env } from '../../env.js';

export const VERIFIER_SYSTEM = `You are the Verifier agent in a software development team.
Your job is to verify that the proposed architecture is technically viable
BEFORE the Designer creates the implementation blueprint.

Verify:
1. CONTEXT LIMITS: Will the Coder's context window (8K output, 256K input)
   handle the proposed number of components? Flag if estimatedComponents > 15.
2. DEPENDENCIES: Are all external libraries/APIs mentioned in the research
   real, current, and available? List any that seem questionable.
3. COMPLEXITY MATCH: Does the tech stack match the complexity level?
   Simple apps should not need microservices. Complex apps need more than
   a single HTML file.
4. CONSTRAINTS: Produce explicit constraints the Designer must follow:
   - Max number of files the Coder should generate
   - Which dependencies are approved vs. risky
   - Any architecture decisions that are pre-validated vs. need design

Respond with ONLY a JSON object matching this exact shape (no prose, no markdown fences):
{
  "summary": string,
  "passed": boolean,
  "contextCheck": {
    "viable": boolean,
    "maxRecommendedFiles": number,
    "estimatedTokensPerFile": number,
    "reasoning": string
  },
  "dependencyCheck": [{
    "name": string,
    "status": "approved" | "risky" | "unknown",
    "notes": string
  }],
  "constraints": string[],
  "recommendations": string[]
}`;

/** Matches `MAX_RETRIES` in designer.ts and auditor.ts. */
const MAX_RETRIES = 2;

const verifierOutputSchema = z.object({
  summary: z.string(),
  passed: z.boolean(),
  contextCheck: z.object({
    viable: z.boolean(),
    maxRecommendedFiles: z.number(),
    estimatedTokensPerFile: z.number(),
    reasoning: z.string(),
  }),
  dependencyCheck: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['approved', 'risky', 'unknown']),
      notes: z.string(),
    })
  ),
  constraints: z.array(z.string()),
  recommendations: z.array(z.string()),
});

export interface VerificationResult {
  summary: string;
  passed: boolean;
  contextCheck: {
    viable: boolean;
    maxRecommendedFiles: number;
    estimatedTokensPerFile: number;
    reasoning: string;
  };
  dependencyCheck: Array<{
    name: string;
    status: string;
    notes: string;
  }>;
  constraints: string[];
  recommendations: string[];
}

export async function runVerifier(
  brief: ProjectBrief,
  research: ResearchFindings,
  auditSummary: string,
  env: Env,
  feedback?: string | null,
  projectId?: string | null,
  tier?: SubscriptionTier
): Promise<{
  verification: VerificationResult;
  tokensIn: number;
  tokensOut: number;
  model: string;
}> {
  // Subconscious Layer: retrieve past verification patterns + rerank + intuition
  const verifyQuery = `Verify task: ${brief.appType} app "${brief.appName}" — tech: ${research.techStack.map((t) => t.recommendation).join(', ')}, components: ${brief.estimatedComponents}`;
  const similarPatterns = await findSimilarPatterns(
    env,
    projectId ?? null,
    verifyQuery,
    'semantic'
  );
  const subconscious = await runSubconscious({
    query: verifyQuery,
    patterns: similarPatterns,
    agentRole: 'verifier',
    tier: tier ?? 'free',
    env,
  });

  const conversation: ChatMessage[] = [
    { role: 'system', content: VERIFIER_SYSTEM },
    {
      role: 'user',
      content:
        `Project Brief:\n${JSON.stringify(brief, null, 2)}\n\n` +
        `Research Findings:\n${JSON.stringify(research).slice(0, 8000)}\n\n` +
        `Audit Summary:\n${auditSummary}` +
        (subconscious.contextBlock || '') +
        (feedback
          ? `\n\nPrevious verification feedback — address this:\n${feedback}`
          : ''),
    },
  ];

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastError = '';
  let validated: z.infer<typeof verifierOutputSchema> | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // On retry, hand the model its own validation error so it can self-correct.
    if (attempt > 0 && lastError) {
      conversation.push({
        role: 'assistant',
        content: '{error: previous response failed validation}',
      });
      conversation.push({
        role: 'user',
        content: `Your previous response failed validation with this error:\n\n${lastError}\n\nReturn a valid JSON object matching the shape above. "contextCheck" is a single object; every entry in "dependencyCheck" must be an object with name, status and notes — not a bare string. "constraints" and "recommendations" are arrays of strings.`,
      });
    }

    const response = await callAgentModel(
      'verifier',
      'simple',
      {
        messages: [...conversation],
        responseFormat: { type: 'json_object' },
        temperature: attempt === 0 ? 0.2 : 0.1, // lower temp on retry
      },
      env,
      tier
    );

    totalTokensIn += response.data.usage.inputTokens;
    totalTokensOut += response.data.usage.outputTokens;

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.data.message.content);
    } catch {
      lastError = 'Invalid JSON — could not parse the response';
      continue;
    }

    const result = verifierOutputSchema.safeParse(parsed);
    if (result.success) {
      validated = result.data;
      break;
    }

    lastError = result.error.message;
    console.warn(
      `Verifier attempt ${attempt + 1}/${MAX_RETRIES + 1} failed validation: ${lastError.slice(0, 200)}`
    );
  }

  if (!validated) {
    throw new GenerationError(
      `Verifier output failed validation after ${MAX_RETRIES + 1} attempts. Last error: ${lastError}`,
      'VERIFIER_INVALID_SCHEMA'
    );
  }

  // Use You.com to verify external dependencies are real and current. This runs
  // once, after the retry loop has settled — the search costs a network round
  // trip per dependency and none of it depends on which attempt succeeded.
  const dependencyNames = research.recommendedLibraries ?? [];
  const verifiedDeps = await Promise.all(
    dependencyNames.slice(0, 5).map((name) => verifyDependency(name, env))
  );

  // Merge verified dependency results with the model's dependency check
  const mergedDeps = [
    ...validated.dependencyCheck,
    ...verifiedDeps.map((d) => ({
      name: d.name,
      status: d.status as 'approved' | 'risky' | 'unknown',
      notes: d.notes,
    })),
  ];

  return {
    verification: {
      ...validated,
      dependencyCheck: mergedDeps,
    },
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    // Same router call the dispatch above made — see the note in auditor.ts
    // (finding M-19: persisted label had drifted from the dispatched model).
    model: selectModel('verifier', 'simple'),
  };
}

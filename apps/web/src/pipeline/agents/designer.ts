/**
 * Agent 3 — Designer (Design Coherent). Turns the project brief + research
 * findings into a complete SystemBlueprint (component tree, DB schema, API
 * routes, auth strategy, env vars, deploy config) for the Coder agent to
 * implement. Always Command A (needs reasoning for system design).
 *
 * Retry logic: if the LLM output fails Zod validation, re-prompt with the
 * error details up to MAX_RETRIES times. This handles the common case of
 * LLMs putting strings in arrays or missing required fields.
 *
 * See @agent_docs/autonomous-dev-team.md.
 */
import { GenerationError } from '@bicameral/shared/errors';
import { systemBlueprintSchema } from '@bicameral/shared/schemas';
import type {
  ProjectBrief,
  ResearchFindings,
  SystemBlueprint,
  SubscriptionTier,
} from '@bicameral/shared';
import { callAgentModel, selectModel } from '../../lib/cohere.js';
import type { ChatMessage } from '@bicameral/cohere/chat';
import {
  findSimilarPatterns,
  formatSimilarPatterns,
} from '../lattice-enrich.js';
import { runSubconscious } from '../subconscious.js';
import type { Env } from '../../env.js';

const MAX_RETRIES = 2;

export const DESIGNER_SYSTEM = `You are the Design agent in a software development team.
Create a complete system blueprint from the project brief and research findings,
for a Code agent to implement. Respond with ONLY a JSON object matching this
exact shape (no prose, no markdown fences):
{
  "components": [{ "path": string, "type": "page"|"component"|"api"|"util"|"schema"|"config", "description": string, "dependencies": string[] }],
  "database": { "tables": object[], "relationships": object[] },
  "apiRoutes": [{ "path": string, "method": string, "description": string }],
  "authStrategy": string,
  "envVars": string[],
  "deployConfig": object
}

CRITICAL: Every entry in the "components" array MUST be an object (not a string)
with all four fields: path, type, description, dependencies. Do NOT put plain
strings in the components array.`;

export async function runDesigner(
  brief: ProjectBrief,
  research: ResearchFindings,
  env: Env,
  feedback?: string | null,
  verificationConstraints?: string[] | null,
  projectId?: string | null,
  tier?: SubscriptionTier
): Promise<{
  blueprint: SystemBlueprint;
  tokensIn: number;
  tokensOut: number;
  model: string;
}> {
  const similar = await findSimilarPatterns(
    env,
    null,
    `${brief.appType} app: ${brief.appName} — ${brief.coreFeatures.join(', ')}`,
    'architecture'
  );
  // Full subconscious: Rerank + intuition layer
  const subconscious = await runSubconscious({
    query: `${brief.appType} app: ${brief.appName} — ${brief.coreFeatures.join(', ')}`,
    patterns: similar,
    agentRole: 'designer',
    tier: tier ?? 'free',
    env,
  });
  const similarBlock =
    subconscious.contextBlock ||
    formatSimilarPatterns(similar, 'Similar past blueprints');

  const messages: ChatMessage[] = [
    { role: 'system', content: DESIGNER_SYSTEM },
    {
      role: 'user',
      content: JSON.stringify({ brief, research }) + similarBlock,
    },
  ];

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // On retry, add the error as feedback so the model can self-correct
    if (attempt > 0 && lastError) {
      messages.push({
        role: 'assistant',
        content: '{error: previous response failed validation}',
      });
      messages.push({
        role: 'user',
        content: `Your previous response failed validation with this error:\n\n${lastError}\n\nPlease fix the issue and return a valid JSON object. Make sure every entry in "components" is an object with path, type, description, and dependencies fields — not a string.`,
      });
    }

    const response = await callAgentModel(
      'designer',
      brief.complexity,
      {
        messages: [...messages],
        responseFormat: { type: 'json_object' },
        temperature: attempt === 0 ? 0.3 : 0.1, // lower temp on retry
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

    const result = systemBlueprintSchema.safeParse(parsed);
    if (result.success) {
      return {
        blueprint: result.data,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        model: selectModel('designer', brief.complexity, tier),
      };
    }

    lastError = result.error.message;
    console.warn(
      `Designer attempt ${attempt + 1}/${MAX_RETRIES + 1} failed validation: ${lastError.slice(0, 200)}`
    );
  }

  // All retries exhausted
  throw new GenerationError(
    `Designer output failed validation after ${MAX_RETRIES + 1} attempts. Last error: ${lastError}`,
    'DESIGNER_INVALID_SCHEMA'
  );
}

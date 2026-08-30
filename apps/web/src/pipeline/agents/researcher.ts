/**
 * Agent 2 — Researcher (Research Discovered). Validates the project brief:
 * tech stack, similar projects, risks, recommended libraries. Always R7B
 * (fast/cheap). When pipeline context (userId/tier) is available, grounds
 * the findings in Rerank-validated results from tools/web-search.ts first —
 * see that module for why "web search" today means candidate generation +
 * real Cohere Rerank scoring rather than a live crawl. Falls back to the
 * model's own knowledge when no context is supplied (e.g. standalone use).
 * See @agent_docs/autonomous-dev-team.md.
 */
import { GenerationError } from '@bicameral/shared/errors';
import { researchFindingsSchema } from '@bicameral/shared/schemas';
import type {
  ProjectBrief,
  ResearchFindings,
  SubscriptionTier,
} from '@bicameral/shared/types';
import { callAgentModel, selectModel } from '../../lib/cohere.js';
import { webSearch } from '../tools/web-search.js';
import { withToolRecord } from '../../lib/tool-record.js';
import {
  findSimilarPatterns,
  formatSimilarPatterns,
} from '../lattice-enrich.js';
import { runSubconscious } from '../subconscious.js';
import { SIM_EVOLVED } from '@bicameral/shared/constants';
import type { Env } from '../../env.js';

export interface ResearcherContext {
  userId: string;
  tier: SubscriptionTier;
  pipelineRunId?: string;
  projectId?: string;
}

const BRIEF_SYSTEM_PROMPT = `You are a senior product manager and technical architect.
Take a founder's vision and turn it into a structured project brief.
Infer sensible defaults for anything the founder didn't specify.

Respond with ONLY a JSON object matching this exact shape (no prose, no markdown fences):
{
  "appName": string,
  "appType": "web" | "mobile" | "fullstack",
  "targetUsers": string,
  "coreFeatures": string[],
  "dataModels": [{ "name": string, "fields": string[] }],
  "techPreferences": string,
  "complexity": "simple" | "moderate" | "complex",
  "estimatedComponents": number
}`;

export const RESEARCHER_SYSTEM = `You are the Research agent in a software development team.
Your job is to validate a project brief by researching:
1. Best tech stack for this type of app
2. Similar existing projects and their architecture patterns
3. Common pitfalls and risks for this domain
4. Recommended libraries and services

Respond with ONLY a JSON object matching this exact shape (no prose, no markdown fences):
{
  "techStack": [{ "category": string, "recommendation": string, "rationale": string }],
  "similarProjects": [{ "name": string, "description": string, "relevantPatterns": string[] }],
  "risks": [{ "description": string, "severity": "low" | "medium" | "high", "mitigation": string }],
  "recommendedLibraries": string[],
  "evidenceRefs": string[]
}`;

export async function runResearcher(
  brief: ProjectBrief,
  env: Env,
  context?: ResearcherContext
): Promise<{
  research: ResearchFindings;
  tokensIn: number;
  tokensOut: number;
  model: string;
}> {
  let evidence: string | null = null;
  if (context) {
    try {
      const query = `${brief.appType} app: ${brief.appName} — ${brief.coreFeatures.join(', ')}`;
      const results = await withToolRecord(
        env.DB,
        context.pipelineRunId,
        { agent: 'researcher', tool: 'web-search', detail: { query } },
        () =>
          webSearch(query, env, {
            userId: context.userId,
            tier: context.tier,
            pipelineRunId: context.pipelineRunId,
            projectId: context.projectId,
          }),
        (found) =>
          found.length > 0
            ? `Searched the web for evidence — ${found.length} result${found.length === 1 ? '' : 's'}.`
            : 'Searched the web for evidence — nothing usable came back.'
      );
      if (results.length > 0) evidence = JSON.stringify(results);
    } catch {
      // Quota exceeded or search failed — fall back to the model's own
      // knowledge. Silent to the run, but no longer silent to the founder:
      // withToolRecord has already filed the failure, which at verbose is the
      // difference between "researched without sources" and "researched".
    }
  }

  const researchQuery = `${brief.appType} app: ${brief.appName} — ${brief.coreFeatures.join(', ')}`;
  const similar = await findSimilarPatterns(
    env,
    context?.projectId ?? null,
    researchQuery,
    'semantic'
  );
  // Full subconscious: Rerank + North Mini Code intuition (enterprise only)
  const subconscious = await runSubconscious({
    query: researchQuery,
    patterns: similar,
    agentRole: 'researcher',
    tier: context?.tier ?? 'free',
    env,
  });
  const similarBlock =
    subconscious.contextBlock ||
    formatSimilarPatterns(similar, 'Similar past research findings');

  const response = await callAgentModel(
    'researcher',
    'simple',
    {
      messages: [
        { role: 'system', content: RESEARCHER_SYSTEM },
        {
          role: 'user',
          content:
            (evidence
              ? `${JSON.stringify(brief)}\n\nRerank-validated reference material:\n${evidence}`
              : JSON.stringify(brief)) + similarBlock,
        },
      ],
      responseFormat: { type: 'json_object' },
      temperature: SIM_EVOLVED.modelTemperature, // simulation-evolved: 0.676
    },
    env,
    context?.tier
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.data.message.content);
  } catch {
    throw new GenerationError(
      'Researcher returned invalid JSON',
      'RESEARCHER_INVALID_JSON'
    );
  }

  let result = researchFindingsSchema.safeParse(parsed);
  if (!result.success) {
    // Retry once with explicit error feedback — the synonym normalizer
    // in schemas.ts handles most cases, but some LLM outputs need a
    // second pass with the exact error message as a correction hint.
    const errorHint = result.error.errors
      .map((e) => `Field "${e.path.join('.')}": ${e.message}`)
      .join('; ');
    const retryResponse = await callAgentModel(
      'researcher',
      'simple',
      {
        messages: [
          { role: 'system', content: RESEARCHER_SYSTEM },
          {
            role: 'user',
            content:
              (evidence
                ? `${JSON.stringify(brief)}\n\nRerank-validated reference material:\n${evidence}`
                : JSON.stringify(brief)) + similarBlock,
          },
          { role: 'assistant', content: response.data.message.content },
          {
            role: 'user',
            content: `Your previous response had validation errors: ${errorHint}. Please fix and return the corrected JSON with the exact enum values: severity must be "low", "medium", or "high".`,
          },
        ],
        responseFormat: { type: 'json_object' },
        temperature: 0.3, // lower temperature for correction pass
      },
      env,
      context?.tier
    );
    try {
      parsed = JSON.parse(retryResponse.data.message.content);
    } catch {
      throw new GenerationError(
        'Researcher returned invalid JSON on retry',
        'RESEARCHER_INVALID_JSON'
      );
    }
    result = researchFindingsSchema.safeParse(parsed);
    if (!result.success) {
      throw new GenerationError(
        `Researcher output failed validation after retry: ${result.error.message}`,
        'RESEARCHER_INVALID_SCHEMA'
      );
    }
    return {
      research: result.data,
      tokensIn:
        response.data.usage.inputTokens + retryResponse.data.usage.inputTokens,
      tokensOut:
        response.data.usage.outputTokens +
        retryResponse.data.usage.outputTokens,
      model: selectModel('researcher', 'simple', context?.tier),
    };
  }

  return {
    research: result.data,
    tokensIn: response.data.usage.inputTokens,
    tokensOut: response.data.usage.outputTokens,
    model: selectModel('researcher', 'simple', context?.tier),
  };
}

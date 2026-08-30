/**
 * Agent 1 — Architect (Prompt Companion). Turns a founder's natural-language
 * vision into a structured ProjectBrief. Always Command A (needs reasoning
 * for ambiguous, non-technical prompts). See @agent_docs/autonomous-dev-team.md.
 */
import { GenerationError } from '@bicameral/shared/errors';
import { projectBriefSchema } from '@bicameral/shared/schemas';
import type { ProjectBrief } from '@bicameral/shared/types';
import { callAgentModel, selectModel } from '../../lib/cohere.js';
import {
  findSimilarPatterns,
  formatSimilarPatterns,
} from '../lattice-enrich.js';
import type { Env } from '../../env.js';

export const ARCHITECT_SYSTEM = `You are the Architect agent in a software development team.
Your job is to take a non-technical founder's vision and turn it into a
structured project brief. Think like a senior product manager and technical
architect combined — infer sensible defaults for anything the founder didn't
specify, and keep core_features and data_models concrete enough for a
research and design team to act on.

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

export async function runArchitect(
  prompt: string,
  env: Env,
  projectId: string | null,
  feedback?: string | null,
  // Optional and last, so existing callers are unaffected. Without it this
  // step could never reach the enterprise model — see callAgentModel.
  tier?: 'free' | 'pro' | 'team' | 'enterprise'
): Promise<{
  brief: ProjectBrief;
  tokensIn: number;
  tokensOut: number;
  model: string;
}> {
  const similar = await findSimilarPatterns(
    env,
    projectId,
    prompt,
    'requirement'
  );

  const userContent =
    (feedback
      ? `Founder's vision: ${prompt}\n\nFounder feedback from a previous blueprint review — incorporate this: ${feedback}`
      : `Founder's vision: ${prompt}`) +
    formatSimilarPatterns(similar, 'Similar past project briefs');

  const response = await callAgentModel(
    'architect',
    'simple',
    {
      messages: [
        { role: 'system', content: ARCHITECT_SYSTEM },
        { role: 'user', content: userContent },
      ],
      responseFormat: { type: 'json_object' },
      temperature: 0.4,
    },
    env,
    tier
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.data.message.content);
  } catch {
    throw new GenerationError(
      'Architect returned invalid JSON',
      'ARCHITECT_INVALID_JSON'
    );
  }

  let result = projectBriefSchema.safeParse(parsed);
  if (!result.success) {
    // Retry once with explicit error feedback
    const errorHint = result.error.errors
      .map((e) => `Field "${e.path.join('.')}": ${e.message}`)
      .join('; ');
    const retryResponse = await callAgentModel(
      'architect',
      'simple',
      {
        messages: [
          { role: 'system', content: ARCHITECT_SYSTEM },
          { role: 'user', content: `Founder's vision: ${prompt}` },
          { role: 'assistant', content: response.data.message.content },
          {
            role: 'user',
            content: `Your previous response had validation errors: ${errorHint}. Please fix and return the corrected JSON. complexity must be "simple", "moderate", or "complex". appType must be "web", "mobile", or "fullstack".`,
          },
        ],
        responseFormat: { type: 'json_object' },
        temperature: 0.3,
      },
      env,
      tier
    );
    try {
      parsed = JSON.parse(retryResponse.data.message.content);
    } catch {
      throw new GenerationError(
        'Architect returned invalid JSON on retry',
        'ARCHITECT_INVALID_JSON'
      );
    }
    result = projectBriefSchema.safeParse(parsed);
    if (!result.success) {
      throw new GenerationError(
        `Architect output failed validation after retry: ${result.error.message}`,
        'ARCHITECT_INVALID_SCHEMA'
      );
    }
    return {
      brief: result.data,
      tokensIn:
        response.data.usage.inputTokens + retryResponse.data.usage.inputTokens,
      tokensOut:
        response.data.usage.outputTokens +
        retryResponse.data.usage.outputTokens,
      model: selectModel('architect'),
    };
  }

  return {
    brief: result.data,
    tokensIn: response.data.usage.inputTokens,
    tokensOut: response.data.usage.outputTokens,
    model: selectModel('architect'),
  };
}

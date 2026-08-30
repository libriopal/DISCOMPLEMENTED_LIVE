/**
 * Tool: CERL web search for the Researcher agent. Rate-limited per tier via
 * lib/research-quota.ts (TIER_LIMITS[tier].researchQueries — the same cap
 * `POST /api/research` enforces, so pipeline-internal searches and a
 * founder's manual research queries share one monthly budget instead of
 * drifting out of sync).
 *
 * You.com Search API (YDC_API_KEY) is the primary search backend, so "search" is
 * candidate generation via the researcher model followed by a real Cohere
 * Rerank v4 pass that scores and filters those candidates against the
 * query — the validation step this tool exists for. Swapping in a live
 * search backend later only touches `generateCandidates`; the rerank
 * validation and rate limiting stay the same.
 */
import { rerank } from '@bicameral/cohere/rerank';
import { COHERE_MODELS, SIM_EVOLVED } from '@bicameral/shared/constants';
import type { SubscriptionTier } from '@bicameral/shared/types';
import { callModel, selectModel } from '../../lib/cohere.js';
import { assertResearchQuota } from '../../lib/research-quota.js';
import type { Env } from '../../env.js';
import { youComSearch } from '../../lib/youcom-research.js';

export interface WebSearchResult {
  title: string;
  content: string;
  relevanceScore: number;
}

interface Candidate {
  title: string;
  content: string;
}

async function generateCandidates(
  query: string,
  env: Env
): Promise<Candidate[]> {
  // 1. Try You.com Search API first (real web results)
  if (env.YDC_API_KEY) {
    try {
      const searchRes = await youComSearch(query, env, { count: 20 });
      if (searchRes.results && searchRes.results.length > 0) {
        return searchRes.results.map((r) => ({
          title: r.title,
          content: r.snippets?.join(' ') || r.description || r.url,
        }));
      }
    } catch {
      // Fall back to model on search failure
    }
  }

  // 2. Fall back to model-generated candidates if You.com is unavailable
  const response = await callModel(
    selectModel('researcher'),
    {
      messages: [
        {
          role: 'system',
          content:
            'List 20 realistic technical reference points (library docs, architecture patterns, ' +
            'known pitfalls) relevant to the query. Respond with ONLY JSON: ' +
            '{ "candidates": [{ "title": string, "content": string }] }',
        },
        { role: 'user', content: query },
      ],
      responseFormat: { type: 'json_object' },
      temperature: 0.5,
    },
    env
  );

  try {
    const parsed = JSON.parse(response.data.message.content) as {
      candidates?: Candidate[];
    };
    return parsed.candidates ?? [];
  } catch {
    return [];
  }
}

export interface WebSearchOptions {
  userId: string;
  tier: SubscriptionTier;
  pipelineRunId?: string;
  projectId?: string;
  topN?: number;
}

export async function webSearch(
  query: string,
  env: Env,
  opts: WebSearchOptions
): Promise<WebSearchResult[]> {
  await assertResearchQuota(env.DB, opts.userId, opts.tier);

  const candidates = await generateCandidates(query, env);
  if (candidates.length === 0) return [];

  const reranked = await rerank(
    {
      model: COHERE_MODELS.rerankFast,
      query,
      documents: candidates.map((c) => `${c.title}\n${c.content}`),
      topN: opts.topN ?? SIM_EVOLVED.rerankDepth, // simulation-evolved: 78
      returnDocuments: false,
    },
    { COHERE_API_KEY: env.COHERE_API_KEY, COHERE_API_BASE: env.COHERE_BASE_URL }
  );

  const results = reranked.data.results
    .map((r) => ({ ...candidates[r.index], relevanceScore: r.relevanceScore }))
    .filter((r): r is Candidate & { relevanceScore: number } =>
      Boolean(r.title)
    );

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO research_queries (id, user_id, project_id, pipeline_run_id, query, results, model_used, credits_used, created_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'system')`
  )
    .bind(
      crypto.randomUUID(),
      opts.userId,
      opts.projectId ?? null,
      opts.pipelineRunId ?? null,
      query,
      JSON.stringify(results),
      COHERE_MODELS.rerankFast,
      now
    )
    .run();

  return results;
}

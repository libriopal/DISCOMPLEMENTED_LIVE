/**
 * Research (CERL) — ad-hoc research queries, credited & tier-capped.
 * See @agent_docs/api-spec.md "Research". The dedicated web-search tool
 * (Rerank-validated CERL search) lands in Phase 5b's web-search.ts; until
 * then this route asks the Researcher model directly for structured
 * findings so the route contract is stable for the frontend/pipeline.
 */
import { Hono } from 'hono';
import { BicameralError, CreditsError } from '@bicameral/shared/errors';
import { CREDIT_COSTS } from '@bicameral/shared/constants';
import { callModel, selectModel } from '../lib/cohere.js';
import { debitCredits } from '../lib/virtual-key.js';
import { assertResearchQuota } from '../lib/research-quota.js';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const researchRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

interface ResearchResult {
  title: string;
  content: string;
  score: number;
}

researchRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const tier = c.get('tier');

  const body = await c.req.json<{
    query: string;
    projectId?: string;
    pipelineRunId?: string;
  }>();
  if (!body.query) {
    throw new BicameralError('query is required', 'VALIDATION_ERROR', 400);
  }

  await assertResearchQuota(c.env.DB, userId, tier);

  const debited = await debitCredits(c.env.DB, userId, CREDIT_COSTS.research);
  if (!debited) throw new CreditsError();

  const model = selectModel('researcher');
  const response = await callModel(
    model,
    {
      messages: [
        {
          role: 'system',
          content:
            'You are a technical research assistant. Given a query, return 3-5 findings as ' +
            'a JSON object: { "results": [{ "title": string, "content": string, "score": number 0-1 }] }.',
        },
        { role: 'user', content: body.query },
      ],
      responseFormat: { type: 'json_object' },
    },
    c.env
  );

  let results: ResearchResult[] = [];
  try {
    const parsed = JSON.parse(response.data.message.content) as {
      results?: ResearchResult[];
    };
    results = parsed.results ?? [];
  } catch (err) {
    // A malformed model response shouldn't fail a request that already
    // debited credits, but silently returning [] with no signal is exactly
    // the pattern that hid the embed.ts bug — log it loudly instead.
    console.error('Research response parse failed', { userId, err });
    results = [];
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO research_queries (id, user_id, project_id, pipeline_run_id, query, results, model_used, credits_used, created_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      body.projectId ?? null,
      body.pipelineRunId ?? null,
      body.query,
      JSON.stringify(results),
      model,
      CREDIT_COSTS.research,
      now,
      userId
    )
    .run();

  return c.json({ id, results });
});

researchRoutes.get('/history', async (c) => {
  const userId = c.get('userId');
  const limit = Math.min(Number(c.req.query('limit') ?? '20') || 20, 100);
  const skip = Math.max(Number(c.req.query('skip') ?? '0') || 0, 0);

  const { results } = await c.env.DB.prepare(
    `SELECT id, query, pipeline_run_id, created_date FROM research_queries
     WHERE user_id = ? ORDER BY created_date DESC LIMIT ? OFFSET ?`
  )
    .bind(userId, limit, skip)
    .all<{
      id: string;
      query: string;
      pipeline_run_id: string | null;
      created_date: string;
    }>();

  return c.json(
    results.map((r) => ({
      id: r.id,
      query: r.query,
      pipelineRunId: r.pipeline_run_id,
      createdAt: r.created_date,
    }))
  );
});

researchRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT * FROM research_queries WHERE id = ? AND user_id = ?'
  )
    .bind(c.req.param('id'), userId)
    .first<{
      id: string;
      query: string;
      results: string | null;
      pipeline_run_id: string | null;
      created_date: string;
    }>();

  if (!row)
    throw new BicameralError(
      'Research query not found',
      'RESEARCH_NOT_FOUND',
      404
    );

  return c.json({
    id: row.id,
    query: row.query,
    results: row.results ? JSON.parse(row.results) : [],
    pipelineRunId: row.pipeline_run_id,
    createdAt: row.created_date,
  });
});

/**
 * Generate — legacy single-agent generation (kept alongside /api/pipeline).
 * See @agent_docs/api-spec.md "Generate". For the full 4-agent pipeline use
 * pipeline.ts instead; this route streams one model's output directly.
 */
import { Hono } from 'hono';
import { BicameralError, CreditsError } from '@bicameral/shared/errors';
import { CREDIT_COSTS, COHERE_MODELS } from '@bicameral/shared/constants';
import { streamChat } from '@bicameral/cohere/streaming';
import { debitCredits, creditUserCredits } from '../lib/virtual-key.js';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const generateRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

interface GenerationRow {
  id: string;
  project_id: string | null;
  user_id: string;
  pipeline_run_id: string | null;
  prompt: string;
  model_used: string;
  files: string | null;
  status: string;
  credits_used: number;
  tokens_in: number;
  tokens_out: number;
  created_date: string;
}

/**
 * Marks a generation failed and returns the credits that were debited before
 * the run started. Credits are taken up front so a concurrent request cannot
 * overdraw the balance, which means every failure path owes a refund — the
 * ledger row is what makes the return auditable rather than a silent balance
 * bump. Refund failures are swallowed: the caller is already inside a stream
 * that must close cleanly, and a lost refund must not also cost the user the
 * error message.
 */
async function failGeneration(
  db: D1Database,
  generationId: string,
  userId: string,
  reason: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE generations SET status = 'failed', credits_used = 0, updated_date = ? WHERE id = ?"
    )
    .bind(now, generationId)
    .run();

  try {
    await creditUserCredits(db, userId, CREDIT_COSTS.generation, {
      type: 'admin_adjustment',
      description:
        `Refund for failed generation ${generationId}: ${reason}`.slice(0, 500),
      createdBy: 'system',
    });
    // creditUserCredits only moves `credits_remaining`; `debitCredits` also
    // raised `credits_used`, which drives the usage meter. Wind that back or
    // the user is shown spend for work that never happened.
    await db
      .prepare(
        'UPDATE users SET credits_used = MAX(0, credits_used - ?), updated_date = ? WHERE id = ?'
      )
      .bind(CREDIT_COSTS.generation, now, userId)
      .run();
  } catch {
    /* balance stays debited; the run is still correctly marked failed */
  }
}

generateRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const tier = c.get('tier');

  const body = await c.req.json<{ prompt?: string; projectId?: string }>();
  if (!body.prompt) {
    throw new BicameralError('prompt is required', 'VALIDATION_ERROR', 400);
  }

  const debited = await debitCredits(c.env.DB, userId, CREDIT_COSTS.generation);
  if (!debited) throw new CreditsError();

  const model = COHERE_MODELS[tier];
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO generations (id, project_id, user_id, pipeline_run_id, prompt, model_used, files, status, credits_used, tokens_in, tokens_out, created_date, updated_date, created_by)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, 'generating', ?, 0, 0, ?, ?, ?)`
  )
    .bind(
      id,
      body.projectId ?? null,
      userId,
      body.prompt,
      model,
      CREDIT_COSTS.generation,
      now,
      now,
      userId
    )
    .run();

  const generator = streamChat(
    {
      model,
      messages: [{ role: 'user', content: body.prompt }],
    },
    {
      COHERE_API_KEY: c.env.COHERE_API_KEY,
      COHERE_API_BASE: c.env.COHERE_BASE_URL,
    }
  );

  const encoder = new TextEncoder();
  const sseBody = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );

      send({ type: 'plan', content: `Generating from: ${body.prompt}` });
      let outputTokens = 0;
      let streamError: string | null = null;
      try {
        for await (const chunk of generator) {
          if (chunk.type === 'text') {
            outputTokens += 1;
            send({ type: 'step', content: chunk.content });
          } else if (chunk.type === 'finish') {
            send({ type: 'complete' });
          } else if (chunk.type === 'error') {
            // An error chunk is yielded, not thrown, so the catch below never
            // sees it — record it here or the run is marked completed.
            streamError = chunk.error ?? 'Generation failed';
            send({ type: 'error', message: streamError });
          }
        }

        // A run that produced no text is a failure regardless of how the
        // stream ended. Treating it as success is how a broken Cohere v2 SSE
        // parser stayed invisible: every generation yielded zero chunks, was
        // recorded `completed`, and was still billed. Credits are returned
        // here because they are debited up front, before any work happens.
        if (streamError || outputTokens === 0) {
          const reason =
            streamError ?? 'Model returned no output; no credits were charged.';
          await failGeneration(c.env.DB, id, userId, reason);
          if (!streamError) send({ type: 'error', message: reason });
        } else {
          await c.env.DB.prepare(
            "UPDATE generations SET status = 'completed', tokens_out = ?, updated_date = ? WHERE id = ?"
          )
            .bind(outputTokens, new Date().toISOString(), id)
            .run();
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Generation failed';
        await failGeneration(c.env.DB, id, userId, message);
        send({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sseBody, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

generateRoutes.post('/project', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ name?: string; prompt?: string }>();
  if (!body.name || !body.prompt) {
    throw new BicameralError(
      'name and prompt are required',
      'VALIDATION_ERROR',
      400
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, user_id, name, description, status, files, created_date, updated_date, created_by)
     VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?)`
  )
    .bind(id, userId, body.name, body.prompt, now, now, userId)
    .run();

  return c.json({ projectId: id }, 201);
});

generateRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT * FROM generations WHERE id = ? AND user_id = ?'
  )
    .bind(c.req.param('id'), userId)
    .first<GenerationRow>();

  if (!row)
    throw new BicameralError(
      'Generation not found',
      'GENERATION_NOT_FOUND',
      404
    );

  return c.json({
    id: row.id,
    status: row.status,
    files: row.files ? JSON.parse(row.files) : [],
    model: row.model_used,
    pipelineRunId: row.pipeline_run_id,
    createdAt: row.created_date,
  });
});

generateRoutes.post('/:id/cancel', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const result = await c.env.DB.prepare(
    "UPDATE generations SET status = 'cancelled', updated_date = ? WHERE id = ? AND user_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')"
  )
    .bind(new Date().toISOString(), id, userId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    throw new BicameralError(
      'Generation not found or already finished',
      'GENERATION_NOT_CANCELLABLE',
      404
    );
  }

  return c.json({ success: true });
});

/**
 * Deploy — stores a generated app's bundled HTML in R2 and returns a
 * public URL. This fixes F-02 (CRITICAL): generated apps now have a real
 * deployment URL that users can share.
 *
 * POST /api/deploy — accepts { pipelineRunId, html }, stores in R2,
 * updates pipeline_runs.deployment_url, returns the URL.
 * GET  /apps/:runId — serves the deployed app from R2 (public, no auth).
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const deployRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

deployRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    pipelineRunId: string;
    html: string;
  }>();

  if (!body.pipelineRunId || !body.html) {
    throw new BicameralError(
      'pipelineRunId and html are required',
      'VALIDATION_ERROR',
      400
    );
  }

  // Verify the user owns this pipeline run
  const run = await c.env.DB.prepare(
    'SELECT id, user_id FROM pipeline_runs WHERE id = ? AND user_id = ?'
  )
    .bind(body.pipelineRunId, userId)
    .first<{ id: string; user_id: string }>();

  if (!run) {
    throw new BicameralError('Pipeline run not found', 'PIPELINE_NOT_FOUND', 404);
  }

  // Store the bundled HTML in R2
  const r2Key = `deployments/${body.pipelineRunId}/index.html`;
  await c.env.BUCKET.put(r2Key, body.html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });

  // Build the deployment URL
  const url = `https://discomplemented.com/apps/${body.pipelineRunId}`;

  // Update the pipeline run with the deployment URL
  await c.env.DB.prepare(
    'UPDATE pipeline_runs SET deployment_url = ?, updated_date = ? WHERE id = ?'
  )
    .bind(url, new Date().toISOString(), body.pipelineRunId)
    .run();

  return c.json({ url, deployed: true });
});

// Public route — serves deployed apps from R2 (no auth required)
deployRoutes.get('/apps/:runId', async (c) => {
  const runId = c.req.param('runId');
  const r2Key = `deployments/${runId}/index.html`;

  const object = await c.env.BUCKET.get(r2Key);
  if (!object) {
    return c.html(
      '<!doctype html><html><body style="font-family:system-ui;padding:48px;text-align:center;color:#71717a"><h2>App not found</h2><p>This deployment may have been removed or never created.</p></body></html>',
      404
    );
  }

  const html = await object.text();
  return c.html(html);
});

// Also handle /apps/:runId/* for sub-routes (SPA fallback)
deployRoutes.get('/apps/:runId/*', async (c) => {
  const runId = c.req.param('runId');
  const r2Key = `deployments/${runId}/index.html`;

  const object = await c.env.BUCKET.get(r2Key);
  if (!object) {
    return c.html('<!doctype html><html><body><p>Not found</p></body></html>', 404);
  }

  const html = await object.text();
  return c.html(html);
});

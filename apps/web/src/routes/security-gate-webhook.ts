/**
 * Security gate webhook — called by .github/workflows/security-gate.yml, not
 * a Bicameral session, so this router is mounted *before* requireAuth in
 * index.ts (like chatWebhookRoutes — see routes/chat.ts) and authenticates
 * with its own shared secret (SECURITY_GATE_WEBHOOK_SECRET) instead.
 *
 * Two calls per scan: the workflow fetches the Coder's just-written files
 * here (rather than needing R2 credentials in the runner), then posts
 * findings back. GenerationOrchestrator.runCoderStep dispatches the
 * workflow and exits — it can't block a Worker request for the ~1-2
 * minutes a run takes (see pipeline/tools/security-scan-gh.ts) — so this
 * callback is what actually resolves the scan: finalize directly via
 * pipeline/finalize-generation.ts (clean, or retries exhausted) or hand
 * findings back to the Coder loop for another pass via
 * GenerationOrchestrator (dirty, retries remaining).
 */
import { Hono } from 'hono';
import {
  AuthError,
  BicameralError,
  ValidationError,
} from '@bicameral/shared/errors';
import { PIPELINE_DEFAULTS } from '@bicameral/shared/constants';
import type { ProjectFile } from '@bicameral/shared/types';
import type { Env } from '../env.js';
import { fileKey } from '../pipeline/tools/write-file.js';
import { finalizeGeneration } from '../pipeline/finalize-generation.js';
import { timingSafeEqual } from '../lib/virtual-key.js';

export const securityGateWebhookRoutes = new Hono<{ Bindings: Env }>();

function verifySecurityGateWebhookSecret(
  env: Env,
  header: string | undefined
): boolean {
  return (
    !!header &&
    !!env.SECURITY_GATE_WEBHOOK_SECRET &&
    timingSafeEqual(header, env.SECURITY_GATE_WEBHOOK_SECRET)
  );
}

interface PipelineRunRow {
  id: string;
  user_id: string;
  project_id: string | null;
  prompt: string;
  security_retry_count: number;
}

interface SecurityGateRunRow {
  id: string;
  pipeline_run_id: string;
  status: string;
  files: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
}

interface SecurityFinding {
  path: string;
  line: number;
  ruleId: string;
  message: string;
  severity: string;
}

// Same fire-and-forget shape as kickOffOrchestrator in routes/pipeline.ts —
// a dropped nudge just stalls the run until something else re-nudges it,
// rather than losing state (state lives in pipeline_runs, not the DO call).
function kickOffOrchestrator(env: Env, pipelineRunId: string) {
  try {
    const stub = env.GENERATION_DO.get(
      env.GENERATION_DO.idFromName(pipelineRunId)
    );
    void stub.fetch('https://do/run', { method: 'POST' }).catch((err) => {
      console.error(
        'security-gate-webhook: DO fetch failed',
        pipelineRunId,
        err
      );
    });
  } catch (err) {
    console.error(
      'security-gate-webhook: failed to get DO stub',
      pipelineRunId,
      err
    );
  }
}

// ============ GET /api/security-gate/:pipelineRunId/files ============
securityGateWebhookRoutes.get('/:pipelineRunId/files', async (c) => {
  if (
    !verifySecurityGateWebhookSecret(c.env, c.req.header('x-webhook-secret'))
  ) {
    throw new AuthError('Invalid security-gate webhook secret');
  }

  const pipelineRunId = c.req.param('pipelineRunId');
  const prefix = fileKey(pipelineRunId, '');
  const listed = await c.env.BUCKET.list({ prefix });
  const files: ProjectFile[] = await Promise.all(
    listed.objects.map(async (obj) => {
      const object = await c.env.BUCKET.get(obj.key);
      return {
        path: obj.key.slice(prefix.length),
        content: object ? await object.text() : '',
        language: 'typescript',
      };
    })
  );

  return c.json({ files });
});

// ============ POST /api/security-gate/:pipelineRunId/callback ============
securityGateWebhookRoutes.post('/:pipelineRunId/callback', async (c) => {
  if (
    !verifySecurityGateWebhookSecret(c.env, c.req.header('x-webhook-secret'))
  ) {
    throw new AuthError('Invalid security-gate webhook secret');
  }

  const pipelineRunId = c.req.param('pipelineRunId');
  const body = await c.req.json<{
    scanId?: string;
    findings?: SecurityFinding[];
    error?: string;
  }>();
  if (!body.scanId) throw new ValidationError('scanId is required');

  const scan = await c.env.DB.prepare(
    'SELECT * FROM security_gate_runs WHERE id = ? AND pipeline_run_id = ?'
  )
    .bind(body.scanId, pipelineRunId)
    .first<SecurityGateRunRow>();
  if (!scan) {
    throw new BicameralError(
      'Security gate run not found',
      'SECURITY_GATE_NOT_FOUND',
      404
    );
  }
  if (scan.status !== 'pending') {
    // Already resolved — a retried webhook delivery, not a real second
    // scan result. No-op rather than double-finalizing or double-retrying.
    return c.json({ status: 'already_resolved' });
  }

  const findings = body.findings ?? [];
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    'UPDATE security_gate_runs SET status = ?, findings = ?, error_message = ?, completed_at = ? WHERE id = ?'
  )
    .bind(
      body.error ? 'error' : 'completed',
      JSON.stringify(findings),
      body.error ?? null,
      now,
      body.scanId
    )
    .run();

  const run = await c.env.DB.prepare('SELECT * FROM pipeline_runs WHERE id = ?')
    .bind(pipelineRunId)
    .first<PipelineRunRow>();
  if (!run) {
    throw new BicameralError(
      'Pipeline run not found',
      'PIPELINE_NOT_FOUND',
      404
    );
  }

  const files: ProjectFile[] = JSON.parse(scan.files);

  // Scan infrastructure failure (workflow itself errored) isn't a code
  // defect — deploy without a scan rather than stranding the run in
  // 'scanning' forever.
  if (body.error || findings.length === 0) {
    await finalizeGeneration(c.env, {
      pipelineRunId,
      projectId: run.project_id,
      userId: run.user_id,
      prompt: run.prompt,
      model: scan.model,
      files,
      tokensIn: scan.tokens_in,
      tokensOut: scan.tokens_out,
      warning: body.error
        ? `Security scan failed to run: ${body.error} — deployed without a scan`
        : null,
    });
    return c.json({ status: 'deployed' });
  }

  const retryCount = run.security_retry_count ?? 0;
  const formatted = findings.map(
    (f) => `${f.path}:${f.line} [${f.severity}/${f.ruleId}] ${f.message}`
  );

  if (retryCount >= PIPELINE_DEFAULTS.maxSecurityGateRetries) {
    // Retry budget exhausted with findings still open — ship it anyway,
    // flagged, mirroring the functional-loop-exhausted path in
    // GenerationOrchestrator.runCoderStep rather than looping forever.
    await finalizeGeneration(c.env, {
      pipelineRunId,
      projectId: run.project_id,
      userId: run.user_id,
      prompt: run.prompt,
      model: scan.model,
      files,
      tokensIn: scan.tokens_in,
      tokensOut: scan.tokens_out,
      warning: `Security gate found ${findings.length} unresolved finding(s) after ${retryCount} retries: ${formatted.join('; ')}`,
    });
    return c.json({ status: 'deployed_with_findings' });
  }

  // Feed findings back to the Coder loop as its next initialErrors (see
  // CoderOptions in pipeline/agents/coder.ts) and re-nudge the DO.
  await c.env.DB.prepare(
    "UPDATE pipeline_runs SET status = 'implementing', pending_security_errors = ?, security_retry_count = ?, updated_date = ? WHERE id = ?"
  )
    .bind(JSON.stringify(formatted), retryCount + 1, now, pipelineRunId)
    .run();

  kickOffOrchestrator(c.env, pipelineRunId);

  return c.json({ status: 'retrying' });
});

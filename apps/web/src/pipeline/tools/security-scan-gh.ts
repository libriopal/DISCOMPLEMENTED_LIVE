/**
 * Tool: dispatch the Coder-loop security gate as a GitHub Actions run
 * instead of the Sandbox DO's Semgrep container (pipeline/tools/security-scan.ts,
 * now unused) — Cloudflare Containers needs the Workers Paid plan, which the
 * account doesn't have (see bicameral_zero-budget-constraint memory), so the
 * registry push 401s regardless of token scope. GitHub-hosted runners give
 * the same Semgrep scan for free.
 *
 * Workers/Durable Objects can't block a request for the ~1-2 minutes a
 * workflow run takes, so this is fire-and-forget: the workflow pulls the
 * Coder's files via `GET /api/security-gate/:id/files` and reports findings
 * back to `POST /api/security-gate/:id/callback` (see
 * routes/security-gate-webhook.ts) — both authenticated with
 * SECURITY_GATE_WEBHOOK_SECRET, a shared secret rather than a per-request
 * signature, since the caller is a single trusted CI job, not a third party.
 */
import type { Env } from '../../env.js';

export async function dispatchSecurityGateWorkflow(
  env: Env,
  pipelineRunId: string,
  scanId: string
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/security-gate.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'bicameral-coder-security-gate',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { pipelineRunId, scanId },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to dispatch security-gate workflow: ${response.status} ${await response.text()}`
    );
  }
}

/**
 * Tool: Sandbox-container-based Coder-loop security gate. UNUSED as of the
 * GitHub Actions security gate (pipeline/tools/security-scan-gh.ts) —
 * Cloudflare Containers requires the Workers Paid plan, which the account
 * doesn't have (see bicameral_zero-budget-constraint memory; Task 5 is on
 * hold), so this path's registry push 401s regardless of token scope. Kept
 * rather than deleted: it's a real Tier 3 implementation, valid again once
 * Workers Paid is enabled and Task 5 is unblocked — coder.ts no longer
 * imports this file.
 */
import type { ProjectFile } from '@bicameral/shared/types';
import type { SecurityFinding } from '../../durable-objects/Sandbox.js';
import type { Env } from '../../env.js';

export type { SecurityFinding };

export interface SecurityScanResult {
  clean: boolean;
  findings: SecurityFinding[];
  error: string | null;
}

export async function runSecurityScan(
  env: Env,
  pipelineRunId: string,
  files: ProjectFile[]
): Promise<SecurityScanResult> {
  const stub = env.PREVIEW_SANDBOX.get(
    env.PREVIEW_SANDBOX.idFromName(`scan:${pipelineRunId}`)
  );

  const response = await stub.fetch('http://sandbox.internal/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });

  if (!response.ok) {
    const body = await response
      .json<{ error?: string }>()
      .catch(() => ({ error: undefined }));
    return {
      clean: false,
      findings: [],
      error: body.error ?? `Scan failed with status ${response.status}`,
    };
  }

  const { findings } = await response.json<{ findings: SecurityFinding[] }>();
  return { clean: findings.length === 0, findings, error: null };
}

export function formatSecurityFindings(findings: SecurityFinding[]): string[] {
  return findings.map(
    (f) => `${f.path}:${f.line} [${f.severity}/${f.ruleId}] ${f.message}`
  );
}

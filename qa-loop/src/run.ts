/**
 * qa-loop entrypoint — runs all 6 checks against local `wrangler dev`
 * (apps/web) and writes a timestamped Markdown report to qa-loop/reports/.
 *
 * Usage: see qa-loop/README.md. In short:
 *   1. In one terminal: cd apps/web && pnpm dev:api   (wrangler dev)
 *   2. In another:      node qa-loop/src/run.ts
 *
 * This script never starts/stops wrangler dev itself — see README for why
 * (a harness that can kill the dev server out from under you mid-debug is
 * more annoying than useful for a v1 you run by hand).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BUDGET, LOCAL_API_BASE_URL, REPO_ROOT } from './config.ts';
import {
  createTestTenant,
  destroyTestTenant,
  sweepOrphanedTestTenants,
  type TestTenant,
} from './testTenant.ts';
import { runDeploymentHealthCheck } from './checks/deploymentHealth.ts';
import { runFunctionalChecklistCheck } from './checks/functionalChecklist.ts';
import { runPipelineSimulationCheck } from './checks/pipelineSimulation.ts';
import { runSecurityRegressionCheck } from './checks/securityRegression.ts';
import { runSupportEscalationCheck } from './checks/supportEscalation.ts';
import { runMobileResponsiveCheck } from './checks/mobileResponsive.ts';
import { buildReportMarkdown } from './report.ts';
import type { CheckResult } from './types.ts';

const execFileAsync = promisify(execFile);

async function getGitInfo(): Promise<{ commit?: string; branch?: string }> {
  try {
    const [{ stdout: commit }, { stdout: branch }] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: REPO_ROOT,
      }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: REPO_ROOT,
      }),
    ]);
    return { commit: commit.trim(), branch: branch.trim() };
  } catch {
    return {};
  }
}

async function checkLocalDevReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_API_BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  const startedAt = new Date();
  console.error(`qa-loop starting at ${startedAt.toISOString()}`);
  console.error(
    `Target: ${LOCAL_API_BASE_URL} (local wrangler dev only — never production)`
  );

  const devReachable = await checkLocalDevReachable();
  if (!devReachable) {
    console.error(
      `\nERROR: local wrangler dev is not reachable at ${LOCAL_API_BASE_URL}.\n` +
        `Start it first: cd apps/web && pnpm dev:api (or wrangler dev), then re-run this script.\n`
    );
    process.exit(1);
  }

  const orphansSwept = await sweepOrphanedTestTenants().catch((err) => {
    console.warn(
      'Warning: failed to sweep orphaned test tenants:',
      err instanceof Error ? err.message : err
    );
    return 0;
  });
  if (orphansSwept > 0)
    console.error(
      `Swept ${orphansSwept} orphaned qa-loop test tenant(s) from a prior interrupted run.`
    );

  let tenant: TestTenant | null = null;
  try {
    tenant = await createTestTenant();
    console.error(`Created test tenant: ${tenant.userId}`);
  } catch (err) {
    console.error(
      'Failed to create test tenant — pipeline simulation and chat probe will be skipped:',
      err
    );
  }

  const results: CheckResult[] = [];

  async function runCheck(label: string, fn: () => Promise<CheckResult>) {
    console.error(`\n--- ${label} ---`);
    try {
      const result = await fn();
      console.error(`  ${result.status.toUpperCase()}: ${result.summary}`);
      results.push(result);
    } catch (err) {
      console.error(
        `  CRASHED: ${err instanceof Error ? err.message : String(err)}`
      );
      results.push({
        id: label.toLowerCase().replace(/\s+/g, '-'),
        title: label,
        status: 'error',
        summary: `Check crashed outside its own try/catch: ${err instanceof Error ? err.message : String(err)}`,
        findings: [],
        durationMs: 0,
      });
    }
  }

  // Each check is independently try/catchable (runCheck above) so one
  // failing check never kills the rest of the run.
  await runCheck('Deployment Health', runDeploymentHealthCheck);
  await runCheck('Functional Checklist', runFunctionalChecklistCheck);
  await runCheck('Pipeline Simulation', () =>
    runPipelineSimulationCheck(tenant)
  );
  await runCheck('Security Regression', runSecurityRegressionCheck);
  await runCheck('Support / Escalation', () =>
    runSupportEscalationCheck(tenant)
  );
  await runCheck('Mobile / Responsive', runMobileResponsiveCheck);

  if (tenant) {
    try {
      await destroyTestTenant(tenant.userId);
      console.error(`\nCleaned up test tenant: ${tenant.userId}`);
    } catch (err) {
      console.warn(
        'Warning: failed to clean up test tenant:',
        err instanceof Error ? err.message : err
      );
    }
  }

  const pipelineResult = results.find((r) => r.id === 'pipeline-simulation');
  const cohereSpendUsd =
    (pipelineResult?.details?.estimatedSpendUsd as number | undefined) ?? 0;
  const budgetCapped =
    pipelineResult?.status === 'warn' &&
    pipelineResult.summary.includes('Budget-capped');

  const finishedAt = new Date();
  const gitInfo = await getGitInfo();

  const humanAttentionFindings: string[] = [];
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity === 'critical' || finding.severity === 'high') {
        humanAttentionFindings.push(
          `**${result.title}**: ${finding.message}${finding.location ? ` (\`${finding.location}\`)` : ''}`
        );
      }
    }
  }

  const meta = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalDurationMs: finishedAt.getTime() - startedAt.getTime(),
    cohereSpendUsd,
    budgetCapUsd: BUDGET.totalUsd,
    budgetCapped,
    testTenantUserId: tenant?.userId,
    gitCommit: gitInfo.commit,
    gitBranch: gitInfo.branch,
  };

  const reportMd = buildReportMarkdown(meta, results, humanAttentionFindings);

  const reportsDir = `${REPO_ROOT}qa-loop/reports/`;
  await mkdir(reportsDir, { recursive: true });
  const filename = `${startedAt.toISOString().replace(/[:.]/g, '-')}.md`;
  const reportPath = `${reportsDir}${filename}`;
  await writeFile(reportPath, reportMd, 'utf-8');

  console.error(`\n=== qa-loop finished ===`);
  console.error(`Report written to: ${reportPath}`);
  console.error(
    `Estimated Cohere/OpenRouter spend this run: $${cohereSpendUsd.toFixed(4)} (cap: $${BUDGET.totalUsd.toFixed(2)})`
  );
  if (humanAttentionFindings.length > 0) {
    console.error(
      `\n!!! ${humanAttentionFindings.length} finding(s) flagged for human attention — see top of report. !!!`
    );
  }
}

main().catch((err) => {
  console.error('qa-loop failed:', err);
  process.exit(1);
});

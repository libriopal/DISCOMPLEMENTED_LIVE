/**
 * Check 4 — Security regression checks against .github/workflows/*.yml.
 *
 * Three things, per file:
 *   a. SHA-pinning: every third-party `uses:` action should be pinned to a
 *      commit SHA (`owner/repo@<40-hex-sha>`), not a floating tag
 *      (`@v4`, `@main`). `actions/*` (GitHub-owned) are lower risk than
 *      third-party but still flagged — floating tags are floating tags.
 *   b. Minimal explicit `permissions:` blocks — a workflow/job with no
 *      `permissions:` at all relies on the repo's default token
 *      permissions, which may be broader than needed.
 *   c. No job shares scope between untrusted-content-reading steps
 *      (checkout of PR head, running semgrep/audit on arbitrary input) and
 *      deploy-secret-holding steps (anything referencing
 *      `secrets.CLOUDFLARE_API_TOKEN`, `secrets.STRIPE_*`, or similar
 *      deploy/prod secrets) within the SAME job.
 *
 * Findings are reported by file:line. This does not modify any workflow —
 * per the task's hard boundaries, an architectural/security finding here is
 * a report item, not something this harness patches.
 */
import { readFile, readdir } from 'node:fs/promises';
import { REPO_ROOT } from '../config.ts';
import type { CheckFinding, CheckResult } from '../types.ts';

const SHA_PIN_PATTERN = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}|[0-9a-f]{7,39})\b/;
const FLOATING_TAG_PATTERN = /^([\w.-]+\/[\w.-]+)@(v?[\w.-]+)$/;
// Deliberately excludes SECURITY_GATE_WEBHOOK_SECRET: that's a narrowly-scoped
// internal secret used only for an authenticated read of this app's own API
// (see security-gate.yml's own comments), not a deploy/infra credential — a
// job holding it isn't the same risk as one holding CLOUDFLARE_API_TOKEN or
// GITHUB_TOKEN write access. A job with `permissions: {}` also can't act on
// GITHUB_TOKEN even if referenced, so that's excluded from this check too.
const DEPLOY_SECRET_PATTERN =
  /secrets\.(CLOUDFLARE_API_TOKEN|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|BICAMERAL_SMOKE_VKEY|GITHUB_TOKEN)\b/;
const UNTRUSTED_CONTENT_PATTERN =
  /pull_request_target|semgrep|security-scan|actions\/checkout@[^\n]*\bref:\s*\$\{\{\s*github\.event\.pull_request\.head/i;

type WorkflowFinding = CheckFinding;

function findLineNumber(lines: string[], needle: string): number {
  const idx = lines.findIndex((l) => l.includes(needle));
  return idx === -1 ? -1 : idx + 1;
}

function analyzeWorkflow(file: string, content: string): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  const lines = content.split('\n');

  // --- (a) SHA-pinning ---
  const usesLines = lines
    .map((line, i) => ({ line, num: i + 1 }))
    .filter(({ line }) => /^\s*(-\s*)?uses:\s*/.test(line));

  for (const { line, num } of usesLines) {
    const ref = line.replace(/^\s*(-\s*)?uses:\s*/, '').trim();
    if (SHA_PIN_PATTERN.test(ref)) continue; // properly pinned
    const floatingMatch = ref.match(FLOATING_TAG_PATTERN);
    if (floatingMatch) {
      findings.push({
        severity: 'medium',
        message: `Third-party action pinned to a floating tag, not a commit SHA: ${ref}`,
        location: `${file}:${num}`,
      });
    }
  }

  // --- (b) permissions blocks ---
  const hasTopLevelPermissions = /^permissions:/m.test(content);
  if (/^jobs:/m.test(content)) {
    // crude job enumeration: top-level keys directly under `jobs:`
    const jobsSectionMatch = content.match(/^jobs:\n([\s\S]*)$/m);
    if (jobsSectionMatch) {
      const jobNames = [
        ...jobsSectionMatch[1].matchAll(/^ {2}([\w-]+):\s*$/gm),
      ].map((m) => m[1]);
      for (const jobName of jobNames) {
        const jobPattern = new RegExp(
          `^  ${jobName}:\\s*\\n([\\s\\S]*?)(?=^  [\\w-]+:\\s*$|\\Z)`,
          'm'
        );
        const jobMatch = jobsSectionMatch[1].match(jobPattern);
        const jobBody = jobMatch?.[1] ?? '';
        const jobHasPermissions = /^\s{4}permissions:/m.test(jobBody);
        if (!hasTopLevelPermissions && !jobHasPermissions) {
          findings.push({
            severity: 'medium',
            message: `Job "${jobName}" has no explicit permissions: block (no top-level permissions: either) — relies on the repo's default GITHUB_TOKEN permissions.`,
            location: `${file} (job: ${jobName})`,
          });
        }
      }
    }
  }

  // --- (c) untrusted-content vs deploy-secret scope sharing within one job ---
  if (/^jobs:/m.test(content)) {
    const jobsSectionMatch = content.match(/^jobs:\n([\s\S]*)$/m);
    if (jobsSectionMatch) {
      const jobNames = [
        ...jobsSectionMatch[1].matchAll(/^ {2}([\w-]+):\s*$/gm),
      ].map((m) => m[1]);
      for (const jobName of jobNames) {
        const jobPattern = new RegExp(
          `^  ${jobName}:\\s*\\n([\\s\\S]*?)(?=^  [\\w-]+:\\s*$|\\Z)`,
          'm'
        );
        const jobMatch = jobsSectionMatch[1].match(jobPattern);
        const jobBody = jobMatch?.[1] ?? '';
        const readsUntrusted = UNTRUSTED_CONTENT_PATTERN.test(jobBody);
        const holdsDeploySecret = DEPLOY_SECRET_PATTERN.test(jobBody);
        const jobHasEmptyPermissions = /^\s{4}permissions:\s*\{\s*\}/m.test(
          jobBody
        );
        if (readsUntrusted && holdsDeploySecret && !jobHasEmptyPermissions) {
          const lineNum = findLineNumber(lines, jobName + ':');
          findings.push({
            severity: 'high',
            message: `Job "${jobName}" appears to both read untrusted content (PR head / semgrep / security-scan) AND hold a deploy/prod secret in the same job — check for scope separation.`,
            location: `${file}${lineNum > 0 ? `:${lineNum}` : ''} (job: ${jobName})`,
          });
        }
      }
    }
  }

  return findings;
}

export async function runSecurityRegressionCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: CheckFinding[] = [];
  const workflowsDir = `${REPO_ROOT}.github/workflows/`;

  try {
    const files = (await readdir(workflowsDir)).filter(
      (f) => f.endsWith('.yml') || f.endsWith('.yaml')
    );
    for (const file of files) {
      const content = await readFile(`${workflowsDir}${file}`, 'utf-8');
      const fileFindings = analyzeWorkflow(
        `.github/workflows/${file}`,
        content
      );
      if (fileFindings.length === 0) {
        findings.push({
          severity: 'info',
          message: `No SHA-pin/permissions/scope-sharing violations found.`,
          location: `.github/workflows/${file}`,
        });
      } else {
        findings.push(...fileFindings);
      }
    }
  } catch (err) {
    return {
      id: 'security-regression',
      title: 'Security Regression (.github/workflows)',
      status: 'error',
      summary: `Could not read .github/workflows/: ${err instanceof Error ? err.message : String(err)}`,
      findings: [],
      durationMs: Date.now() - start,
    };
  }

  const highOrAbove = findings.filter(
    (f) => f.severity === 'high' || f.severity === 'critical'
  );
  const status =
    highOrAbove.length > 0
      ? 'fail'
      : findings.some((f) => f.severity === 'medium')
        ? 'warn'
        : 'pass';

  return {
    id: 'security-regression',
    title: 'Security Regression (.github/workflows)',
    status,
    summary: `${findings.filter((f) => f.severity !== 'info').length} violation(s) found across workflow files. ${highOrAbove.length} high/critical.`,
    findings,
    durationMs: Date.now() - start,
  };
}

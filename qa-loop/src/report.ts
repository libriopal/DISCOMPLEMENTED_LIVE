import type { CheckResult, HarnessRunMeta } from './types.ts';

const STATUS_EMOJI: Record<CheckResult['status'], string> = {
  pass: '[PASS]',
  warn: '[WARN]',
  fail: '[FAIL]',
  skipped: '[SKIPPED]',
  error: '[ERROR]',
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

/** Very cheap secret-shape scanner — refuses to write a report if it looks
 * like a raw key/token leaked into a finding message or detail blob. Not a
 * substitute for care in what checks log, but a last-line-of-defense per
 * the task's "check they don't leak real secrets before writing" requirement. */
function scanForLikelySecrets(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['Cohere-style API key', /\bco_[A-Za-z0-9]{20,}\b/],
    ['OpenRouter-style key', /\bsk-or-[A-Za-z0-9-]{10,}\b/],
    ['Stripe secret key', /\bsk_(live|test)_[A-Za-z0-9]{10,}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
    ['Generic long bearer token', /Bearer\s+[A-Za-z0-9._-]{30,}/],
  ];
  const hits: string[] = [];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}

function renderFindings(result: CheckResult): string {
  if (result.findings.length === 0) return '_No findings recorded._\n';
  const sorted = [...result.findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
  const lines = sorted.map((f) => {
    const loc = f.location ? ` (\`${f.location}\`)` : '';
    return `- **[${f.severity.toUpperCase()}]**${loc} ${f.message}`;
  });
  return lines.join('\n') + '\n';
}

export function buildReportMarkdown(
  meta: HarnessRunMeta,
  results: CheckResult[],
  humanAttentionFindings: string[]
): string {
  const lines: string[] = [];

  lines.push(`# QA Loop Report — ${meta.startedAt}`);
  lines.push('');
  lines.push(
    '> Question this answers: "if a real founder used this right now, end-to-end, would we know before they told us?"'
  );
  lines.push('');

  if (humanAttentionFindings.length > 0) {
    lines.push('## NEEDS HUMAN ATTENTION');
    lines.push('');
    for (const item of humanAttentionFindings) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Run summary');
  lines.push('');
  lines.push(`- Started: ${meta.startedAt}`);
  lines.push(`- Finished: ${meta.finishedAt}`);
  lines.push(`- Total duration: ${(meta.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(
    `- Estimated Cohere/OpenRouter spend: $${meta.cohereSpendUsd.toFixed(4)} (cap: $${meta.budgetCapUsd.toFixed(2)})`
  );
  lines.push(`- Budget capped mid-run: ${meta.budgetCapped ? 'YES' : 'no'}`);
  if (meta.gitCommit)
    lines.push(
      `- Git commit: ${meta.gitCommit}${meta.gitBranch ? ` (${meta.gitBranch})` : ''}`
    );
  lines.push(`- Test tenant: ${meta.testTenantUserId ?? '(none created)'}`);
  lines.push('');

  lines.push('## Checks');
  lines.push('');
  lines.push('| # | Check | Status | Summary |');
  lines.push('|---|---|---|---|');
  results.forEach((r, i) => {
    const summary = r.summary.replace(/\|/g, '\\|').slice(0, 140);
    lines.push(
      `| ${i + 1} | ${r.title} | ${STATUS_EMOJI[r.status]} | ${summary} |`
    );
  });
  lines.push('');

  for (const result of results) {
    lines.push(`### ${result.title}`);
    lines.push('');
    lines.push(`**Status:** ${STATUS_EMOJI[result.status]}  `);
    lines.push(`**Duration:** ${(result.durationMs / 1000).toFixed(2)}s  `);
    if (result.unverifiable) {
      lines.push(
        `**Unverifiable:** ${result.unverifiableReason ?? '(reason not given)'}  `
      );
    }
    lines.push('');
    lines.push(result.summary);
    lines.push('');
    lines.push('**Findings:**');
    lines.push('');
    lines.push(renderFindings(result));
    lines.push('');
  }

  const md = lines.join('\n');

  const secretHits = scanForLikelySecrets(md);
  if (secretHits.length > 0) {
    throw new Error(
      `Refusing to write report — content matched likely-secret pattern(s): ${secretHits.join(', ')}. This is a bug in a check (it logged something it shouldn't have) — fix the check, don't bypass this guard.`
    );
  }

  return md;
}

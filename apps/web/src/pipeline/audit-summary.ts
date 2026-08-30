/**
 * How an audit result is described to the founder.
 *
 * Its own module rather than a private function in `GenerationOrchestrator`
 * because that file imports `cloudflare:workers` and so cannot be loaded
 * outside the Workers runtime — and this is a copy rule, which is exactly the
 * kind of thing that should be cheap to test.
 */
import type { AuditResult } from './agents/auditor.js';

/**
 * Every number in here is a count of things the auditor named, each of which
 * can be read and disagreed with. That is the whole of the rule: a figure in
 * user-facing copy has to be reproducible from the repo, and a tally of the
 * items in a list is. A percentage summarising them is not — see `auditor.ts`
 * for the `coverageScore` this replaced.
 */
export function describeFindings(findings: AuditResult['findings']): string {
  if (findings.length === 0) return 'No findings.';
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const parts = [
    `${findings.length} finding${findings.length === 1 ? '' : 's'}`,
  ];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warnings > 0)
    parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return `${parts.join(', ')}.`;
}

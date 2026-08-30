/**
 * The no-unfounded-percentage rule, applied to the audit step.
 *
 * `glaas/no-ceiling.test.ts` pins the same rule for the 91.3 figure. This is
 * the second place the same defect had grown: the auditor was asked for a
 * `coverageScore`, the orchestrator printed it to the founder as
 * `Coverage: 87%`, and it was stored on the run — which `GET /api/pipeline/:id`
 * returns whole. Nothing computed it.
 *
 * Asserting on the exported prompt and schema rather than on the file text,
 * because the source deliberately keeps a comment at each removal site
 * explaining why the number is gone.
 */
import { describe, it, expect } from 'vitest';
import { AUDITOR_SYSTEM } from './auditor.js';
import { describeFindings } from '../audit-summary.js';

describe('the auditor is not asked for a score', () => {
  it('does not name coverageScore in the output shape it requests', () => {
    expect(AUDITOR_SYSTEM).not.toContain('coverageScore');
  });

  it('tells the model explicitly not to invent one', () => {
    // Removing the field from the schema is not enough on its own: a model
    // asked to audit "coverage" volunteers a percentage in `summary` unless
    // told not to, and `summary` is user-facing too.
    expect(AUDITOR_SYSTEM.toLowerCase()).toContain(
      'do not report a coverage percentage'
    );
  });
});

describe('what the founder is told instead', () => {
  it('reports counts, which are reproducible from the findings list', () => {
    expect(
      describeFindings([
        {
          type: 'gap',
          severity: 'critical',
          description: 'No auth story',
          recommendation: 'Pick one',
        },
        {
          type: 'bias',
          severity: 'warning',
          description: 'Optimistic timeline',
          recommendation: 'Widen it',
        },
        {
          type: 'coverage',
          severity: 'info',
          description: 'Minor',
          recommendation: 'Note it',
        },
      ])
    ).toBe('3 findings, 1 critical, 1 warning.');
  });

  it('says so plainly when there is nothing to report', () => {
    // Not "0 findings, 0 critical" — an empty audit and a clean one read the
    // same to a founder, and only one of them is what happened.
    expect(describeFindings([])).toBe('No findings.');
  });

  it('never emits a percentage', () => {
    const findings = Array.from({ length: 7 }, (_, i) => ({
      type: 'gap',
      severity: i < 3 ? 'critical' : 'info',
      description: 'x',
      recommendation: 'y',
    }));
    expect(describeFindings(findings)).not.toContain('%');
  });
});

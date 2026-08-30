/**
 * The §4C bounds are only worth having if they hold. These are the assertions
 * for the two that are computed rather than judged: the ban on fixes that
 * weaken the check, and the convergence check that stops a thrashing loop
 * before it spends its attempt budget.
 *
 * The negative cases matter as much as the positive ones. A tripwire that fires
 * on legitimate code gets disabled, and a disabled tripwire is worse than none —
 * so every banned pattern is also tested against the shape it must *not* catch.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, deliberately not built. The gate must
// not depend on a build step, so the module has no declarations.
import {
  classifyFix,
  isConverging,
  failureSignature,
  MAX_ATTEMPTS,
} from './self-heal.mjs';

const diff = (...lines: string[]) => lines.join('\n');

describe('classifyFix — fixes that are really escalations', () => {
  it.each([
    ['skipped-test', '+  it.skip("does the thing", () => {'],
    ['only-test', '+  it.only("does the thing", () => {'],
    ['deleted-test', '-  it("does the thing", () => {'],
    ['ts-ignore', '+  // @ts-ignore'],
    ['eslint-disable', '+  // eslint-disable-next-line no-explicit-any'],
    ['widened-to-any', '+  const run: any = loadRun();'],
    ['continue-on-error', '+        continue-on-error: true'],
    ['swallowed-exit', '+  pnpm test:unit || true'],
    ['empty-catch', '+  try { risky(); } catch {}'],
    ['raised-timeout', '+  testTimeout: 300000,'],
  ])('catches %s', (id, line) => {
    const result = classifyFix(diff('--- a/x', '+++ b/x', line));
    expect(result.isEscalation).toBe(true);
    expect(result.violations.map((v: { id: string }) => v.id)).toContain(id);
  });

  it('catches a deleted migration', () => {
    const result = classifyFix(
      diff(
        'diff --git a/migrations/019_user_roles.sql b/migrations/019_user_roles.sql',
        'deleted file mode 100644',
        '--- a/migrations/019_user_roles.sql',
        '+++ /dev/null',
        '-CREATE TABLE foo (id TEXT);'
      )
    );
    expect(result.violations.map((v: { id: string }) => v.id)).toContain(
      'deleted-migration'
    );
  });

  it('reports every violation, not just the first', () => {
    // A diff weakening three checks is a different conversation from one
    // weakening one. Returning only the first would let the loop fix that and
    // re-run straight into the next.
    const result = classifyFix(
      diff(
        '--- a/x',
        '+++ b/x',
        '+  // @ts-ignore',
        '+  const x: any = 1;',
        '+  it.skip("y", () => {})'
      )
    );
    expect(result.violations.length).toBe(3);
  });
});

describe('classifyFix — what it must not catch', () => {
  it('passes a real fix that adds a null check', () => {
    const result = classifyFix(
      diff(
        '--- a/apps/web/src/pipeline/gates.ts',
        '+++ b/apps/web/src/pipeline/gates.ts',
        '+  if (run.current_gate === null) return "no gate";',
        '   return run.current_gate.toUpperCase();'
      )
    );
    expect(result.isEscalation).toBe(false);
  });

  it('passes a diff that adds a test rather than removing one', () => {
    const result = classifyFix(
      diff(
        '--- a/x.test.ts',
        '+++ b/x.test.ts',
        '+  it("rejects a null gate", () => {',
        '+    expect(gateLabel(run)).toBe("no gate");',
        '+  });'
      )
    );
    expect(result.isEscalation).toBe(false);
  });

  it('does not fire on a removed `any` — that is the fix, not the defect', () => {
    // The pattern is anchored to added lines. A diff that *deletes* `: any` is
    // narrowing a type, which is exactly what should be encouraged; catching it
    // would punish the correct change and get the check switched off.
    const result = classifyFix(
      diff(
        '--- a/x.ts',
        '+++ b/x.ts',
        '-  const run: any = loadRun();',
        '+  const run: PipelineRunRow = loadRun();'
      )
    );
    expect(result.isEscalation).toBe(false);
  });

  it('does not fire on a modest timeout', () => {
    // 10000ms is a plausible per-test budget; the pattern targets the five-digit
    // "make the hang fit" values.
    const result = classifyFix(
      diff('--- a/x', '+++ b/x', '+  testTimeout: 9000,')
    );
    expect(result.isEscalation).toBe(false);
  });
});

describe('isConverging', () => {
  const attempt = (output: string) => ({ output });

  it('says too early to tell on the first attempt', () => {
    expect(isConverging([attempt('FAIL a\nFAIL b')]).converging).toBe(true);
  });

  it('converges when the failure set shrinks', () => {
    const result = isConverging([
      attempt('FAIL a.test.ts\nFAIL b.test.ts\nFAIL c.test.ts'),
      attempt('FAIL a.test.ts'),
    ]);
    expect(result.converging).toBe(true);
  });

  it('converges when nothing is failing any more', () => {
    expect(isConverging([attempt('FAIL a'), attempt('')]).converging).toBe(
      true
    );
  });

  it('does NOT converge when the failure set grows', () => {
    const result = isConverging([
      attempt('FAIL a.test.ts'),
      attempt('FAIL a.test.ts\nFAIL b.test.ts\nFAIL c.test.ts'),
    ]);
    expect(result.converging).toBe(false);
    expect(result.reason).toMatch(/grew/);
  });

  it('does NOT converge on thrash — same count, different failures', () => {
    // The case the check exists for. Every count-based measure calls this
    // steady progress, and it will keep looking like progress right up to the
    // attempt budget.
    const result = isConverging([
      attempt('FAIL a.test.ts\nFAIL b.test.ts'),
      attempt('FAIL x.test.ts\nFAIL y.test.ts'),
    ]);
    expect(result.converging).toBe(false);
    expect(result.reason).toMatch(/moving the breakage/);
  });
});

describe('failureSignature', () => {
  it('is stable across line-number shifts', () => {
    // A fix one line above moves every line number below it. Treating that as a
    // new failure would make convergence unmeasurable.
    const a = failureSignature('FAIL src/x.ts:41:9 AssertionError: expected 1');
    const b = failureSignature('FAIL src/x.ts:57:9 AssertionError: expected 1');
    expect(a).toBe(b);
  });

  it('distinguishes genuinely different failures', () => {
    expect(failureSignature('FAIL src/a.ts Error: boom')).not.toBe(
      failureSignature('FAIL src/b.ts Error: boom')
    );
  });

  it('is order-independent', () => {
    // Test runners do not guarantee failure order between runs, and an ordering
    // difference is not a new failure.
    expect(failureSignature('FAIL b\nFAIL a')).toBe(
      failureSignature('FAIL a\nFAIL b')
    );
  });

  it('ignores lines that are not failures', () => {
    expect(failureSignature('all good\n 12 passed')).toBe('');
  });
});

describe('MAX_ATTEMPTS', () => {
  it('is 3', () => {
    // Pinned rather than assumed. The whole value of the bound is that it is a
    // number someone has to deliberately change, in a diff, past this test.
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

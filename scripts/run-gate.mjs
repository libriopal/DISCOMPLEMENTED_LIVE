#!/usr/bin/env node
/**
 * Runs the full gate and records the result as evidence for the §4B audit.
 *
 * §4B requirement 2 is "evidence in, or no verdict": an auditor reasoning about
 * code it cannot see run is producing plausible text, not an audit. That is
 * only enforceable if the evidence can be shown to belong to *this* working
 * tree. Test output from ten minutes and four edits ago looks exactly like
 * fresh output, and an auditor handed stale green output will confidently
 * approve a diff that does not build.
 *
 * So this script stamps the evidence with the tree hash it was produced from —
 * `git write-tree` over the index plus a digest of unstaged tracked changes —
 * and `audit-diff.mjs` refuses to run when that stamp does not match the tree
 * it is auditing. The failure mode being closed here is not laziness; it is
 * that stale evidence is invisible.
 *
 * Usage:
 *   node scripts/run-gate.mjs           # run the gate, write .audit/gate-evidence.json
 *   node scripts/run-gate.mjs --quick   # typecheck + unit only, marked partial
 *
 * `--quick` exists because the full gate takes about three minutes and a
 * pre-commit hook that costs three minutes gets bypassed. Evidence recorded
 * this way is flagged `partial: true`, and the auditor is told which legs did
 * not run rather than being allowed to assume they passed.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EVIDENCE_PATH = resolve(ROOT, '.audit', 'gate-evidence.json');

/**
 * A hash identifying the exact content the gate ran against.
 *
 * `git write-tree` alone covers the index, which is what gets committed — but
 * the gate runs against the *working tree*, and those differ whenever
 * something is edited without staging. Both go into the identity: an audit is
 * about the diff being committed, and the evidence is about the files that
 * were actually executed. Mixing them up is how you get a green audit for a
 * commit whose tests were never run in that shape.
 */
export function treeIdentity(cwd = ROOT) {
  const staged = spawnSync('git', ['write-tree'], {
    cwd,
    encoding: 'utf8',
  });
  if (staged.status !== 0) {
    throw new Error(`git write-tree failed: ${staged.stderr?.trim()}`);
  }
  // Unstaged changes to tracked files. `git diff` output is stable for a given
  // content, so hashing it distinguishes "gate ran, then I edited" from "gate
  // ran on this".
  const unstaged = spawnSync('git', ['diff'], { cwd, encoding: 'utf8' });
  const dirty = spawnSync('git', ['hash-object', '--stdin'], {
    cwd,
    input: unstaged.stdout ?? '',
    encoding: 'utf8',
  });
  return {
    tree: staged.stdout.trim(),
    worktree: dirty.stdout.trim(),
  };
}

const LEGS = [
  { name: 'lint:migrations', args: ['lint:migrations'], quick: false },
  { name: 'typecheck', args: ['typecheck'], quick: true },
  { name: 'test:unit', args: ['test:unit'], quick: true },
  { name: 'test:integration', args: ['test:integration'], quick: false },
  { name: 'test:security', args: ['test:security'], quick: false },
  { name: 'test:e2e', args: ['test:e2e'], quick: false },
  { name: 'build', args: ['build'], quick: false },
];

/**
 * Truncates from the middle. The head carries the command and the first
 * failure; the tail carries the summary line. Cutting only the tail throws
 * away the count of what failed, which is the part an auditor reasons from.
 */
function clamp(text, limit = 24_000) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const cut = text.length - limit;
  return (
    text.slice(0, half) +
    `\n\n... [${cut} characters of output elided from the middle] ...\n\n` +
    text.slice(-half)
  );
}

function main() {
  const quick = process.argv.includes('--quick');
  const legs = quick ? LEGS.filter((l) => l.quick) : LEGS;
  const skipped = quick ? LEGS.filter((l) => !l.quick).map((l) => l.name) : [];

  const before = treeIdentity();
  const results = [];
  const startedAt = new Date().toISOString();

  for (const leg of legs) {
    process.stderr.write(`\n=== gate: pnpm ${leg.args.join(' ')} ===\n`);
    const started = Date.now();
    const run = spawnSync('pnpm', leg.args, {
      cwd: ROOT,
      encoding: 'utf8',
      // Captured *and* echoed: the human running this needs to see progress,
      // and the auditor needs the text. stdio:'inherit' would give only the
      // first, a pure pipe only the second.
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = (run.stdout ?? '') + (run.stderr ?? '');
    process.stderr.write(output);

    results.push({
      leg: leg.name,
      command: `pnpm ${leg.args.join(' ')}`,
      exitCode: run.status ?? -1,
      durationMs: Date.now() - started,
      output: clamp(output),
    });

    // Stop at the first failure. The remaining legs would be reporting on a
    // tree already known to be broken, and the auditor should see the first
    // real failure rather than a cascade of consequences.
    if (run.status !== 0) break;
  }

  const after = treeIdentity();
  // If the tree moved while the gate ran, the evidence describes neither the
  // before nor the after state. Recording it anyway would be worse than
  // recording nothing, because it would look valid.
  if (after.tree !== before.tree || after.worktree !== before.worktree) {
    console.error(
      '\nThe working tree changed while the gate was running, so this evidence ' +
        'describes no single state of the code. Nothing was written. Re-run with ' +
        'the tree held still.'
    );
    process.exit(2);
  }

  const evidence = {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    identity: after,
    partial: quick,
    skippedLegs: skipped,
    results,
    passed: results.every((r) => r.exitCode === 0) && results.length === legs.length,
  };

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

  const failed = results.filter((r) => r.exitCode !== 0);
  process.stderr.write(
    `\ngate evidence written to .audit/gate-evidence.json — ` +
      `${results.length} leg(s) run, ${failed.length} failed` +
      (quick ? `, ${skipped.length} skipped (--quick)` : '') +
      '\n'
  );

  process.exit(evidence.passed ? 0 : 1);
}

// Only run when invoked directly; audit-diff.mjs imports treeIdentity from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

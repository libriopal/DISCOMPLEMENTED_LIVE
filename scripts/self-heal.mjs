#!/usr/bin/env node
/**
 * §4C — the bounds on the self-healing loop, as code.
 *
 * The loop itself is judgement: capture a failure, diagnose the root cause, fix
 * it, re-run the full gate, audit the diff. That part cannot be automated away
 * and this file does not try to. What it does is hold the three bounds that
 * separate self-healing from self-destruction, because each of them fails in a
 * way that feels reasonable from the inside:
 *
 *   - **MAX_ATTEMPTS = 3.** The fourth attempt always feels close. It is not a
 *     budget you can feel your way to the edge of; it is a number, checked.
 *
 *   - **Convergence.** If each fix produces a new or reshaped failure instead
 *     of shrinking the set, the loop is not making progress — it is
 *     redistributing the breakage. That reads identically to progress from
 *     inside attempt 2, which is why it is computed from the recorded failure
 *     signatures rather than judged.
 *
 *   - **A fix may never weaken the check.** This is the loop's characteristic
 *     failure, and the reason it is characteristic is that weakening a check
 *     is genuinely the fastest way to make a gate green. `classifyFix` reads a
 *     candidate diff for the banned shapes and reports them. It is a
 *     tripwire, not a proof — a determined weakening can be written in a form
 *     no regex catches — so it is deliberately noisy at the boundary and its
 *     verdict is "this looks like an escalation", not "this is fine".
 *
 * Recorded attempts go to .audit/healing.jsonl and, when a database is
 * available, to `self_healing_attempts` (migration 025). Persisting them is not
 * bookkeeping: "the loop needed three attempts" is a measurable statement about
 * the codebase, and it cannot be measured from a terminal that has scrolled.
 *
 * Usage:
 *   node scripts/self-heal.mjs record --key <failure-key> --command <cmd> \
 *     --exit <n> --output-file <path> --diagnosis "..." --fix "..." \
 *     --outcome fixed|failed|escalated [--escalation-reason ...]
 *   node scripts/self-heal.mjs status --key <failure-key>
 *   node scripts/self-heal.mjs check-fix --diff-file <path>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEALING_LOG = resolve(ROOT, '.audit', 'healing.jsonl');

/** CONSTRAINT. Not raised because a fix feels close. */
export const MAX_ATTEMPTS = 3;

/**
 * Shapes that make a check pass by making it check less.
 *
 * Each pattern is paired with what it looks like when it is legitimate,
 * because every one of these has a defensible use and the point is not to ban
 * the syntax — it is to make sure a human decided, rather than a loop reaching
 * for the nearest green.
 */
const BANNED_FIX_PATTERNS = [
  {
    id: 'skipped-test',
    // A skipped test reports success while testing nothing, which is strictly
    // worse than a failing one: the failure at least tells you something.
    pattern: /^\+.*\b(it|test|describe)\.(skip|todo)\b/m,
    why: 'a test was skipped rather than fixed',
  },
  {
    id: 'only-test',
    // `.only` silently stops every other test in the file from running.
    pattern: /^\+.*\b(it|test|describe)\.only\b/m,
    why: '.only was added, which disables every other test in the file',
  },
  {
    id: 'deleted-test',
    pattern: /^-\s*(it|test)\s*\(/m,
    why: 'a test case was deleted',
  },
  {
    id: 'ts-ignore',
    pattern: /^\+.*@ts-(ignore|expect-error|nocheck)/m,
    why: 'a type error was silenced rather than resolved',
  },
  {
    id: 'eslint-disable',
    pattern: /^\+.*eslint-disable/m,
    why: 'a lint rule was disabled',
  },
  {
    id: 'widened-to-any',
    pattern: /^\+.*:\s*any\b/m,
    why: 'a type was widened to any',
  },
  {
    id: 'continue-on-error',
    pattern: /^\+.*continue-on-error\s*:\s*true/m,
    why: 'a CI step was made unable to fail',
  },
  {
    id: 'swallowed-exit',
    pattern: /^\+.*\|\|\s*true\b/m,
    why: 'a non-zero exit was swallowed with `|| true`',
  },
  {
    id: 'empty-catch',
    pattern: /^\+.*catch\s*(\([^)]*\))?\s*\{\s*\}/m,
    why: 'an error is caught and discarded',
  },
  {
    id: 'deleted-migration',
    pattern: /^--- a\/migrations\/\d+_.*\.sql$[\s\S]*?^\+\+\+ \/dev\/null$/m,
    why: 'a migration was deleted rather than fixed',
  },
  {
    id: 'raised-timeout',
    // Raising a timeout turns a hang into a slow pass. The hang is still there.
    pattern: /^\+.*\b(timeout|testTimeout|hookTimeout)\s*[:=]\s*\d{5,}/m,
    why: 'a timeout was raised, which hides a hang rather than fixing it',
  },
];

/**
 * Reads a candidate fix for the banned shapes.
 *
 * Returns every match rather than the first: a diff that weakens three checks
 * is a different conversation from one that weakens one, and reporting only the
 * first would let the loop fix that one and re-run into the next.
 */
export function classifyFix(diff) {
  const violations = BANNED_FIX_PATTERNS.filter((p) => p.pattern.test(diff)).map(
    ({ id, why }) => ({ id, why })
  );
  return {
    isEscalation: violations.length > 0,
    violations,
  };
}

/**
 * A stable signature for one failure, used to tell "the same thing is still
 * broken" from "something else is broken now".
 *
 * Numbers are stripped because line numbers, durations, and counts move for
 * reasons that have nothing to do with whether the failure is the same one —
 * a fix one line above shifts every line number below it, and treating that as
 * a new failure would make convergence unmeasurable.
 */
export function failureSignature(output) {
  return output
    .split('\n')
    .filter((l) => /\b(FAIL|Error|error TS|✗|×|AssertionError)\b/.test(l))
    .map((l) =>
      l
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .sort()
    .join('\n');
}

/**
 * Is the loop converging?
 *
 * Convergence means the failure set is shrinking or stable-and-being-worked,
 * not merely changing. A loop whose every attempt produces a differently-shaped
 * failure is redistributing breakage, and it will keep feeling productive right
 * up to the attempt budget. Stopping there is the whole point of the check —
 * "stop even if attempts remain".
 *
 * `attempts` is the recorded history for one failure key, oldest first.
 */
export function isConverging(attempts) {
  if (attempts.length < 2) return { converging: true, reason: 'too early to tell' };

  const signatures = attempts.map((a) => failureSignature(a.output ?? ''));
  const sizes = signatures.map((s) => (s === '' ? 0 : s.split('\n').length));
  const latest = sizes[sizes.length - 1];
  const previous = sizes[sizes.length - 2];

  if (latest === 0) return { converging: true, reason: 'no failures left' };
  if (latest < previous) {
    return { converging: true, reason: `failures ${previous} → ${latest}` };
  }

  // Same size but entirely different content is the thrash case: it looks like
  // steady progress by any count-based measure while nothing is being fixed.
  const overlap = signatures[signatures.length - 1]
    .split('\n')
    .filter((l) => signatures[signatures.length - 2].includes(l)).length;

  if (overlap === 0) {
    return {
      converging: false,
      reason:
        `attempt ${attempts.length} produced an entirely different failure set ` +
        `(${previous} → ${latest}, no overlap). The fixes are moving the breakage, ` +
        `not reducing it.`,
    };
  }

  if (latest > previous) {
    return {
      converging: false,
      reason: `failures grew ${previous} → ${latest}; each fix is costing more than it buys`,
    };
  }

  return { converging: true, reason: `failures steady at ${latest}, partial overlap` };
}

export function readAttempts(failureKey) {
  if (!existsSync(HEALING_LOG)) return [];
  return readFileSync(HEALING_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((a) => a.failureKey === failureKey);
}

/**
 * Whether another attempt is permitted, and why not when it is not.
 *
 * The refusal messages are written to be usable as the opening of an
 * escalation report, because that is what has to happen next and a good
 * escalation report is worth more than a forced green.
 */
export function canAttempt(failureKey) {
  const attempts = readAttempts(failureKey);

  if (attempts.some((a) => a.outcome === 'fixed')) {
    return { allowed: false, reason: 'already fixed', attempts };
  }

  if (attempts.length >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      reason:
        `MAX_ATTEMPTS (${MAX_ATTEMPTS}) spent on "${failureKey}". This escalates. ` +
        `Write the escalation report: what failed, the exact command and output, ` +
        `what each attempt tried and why it did not work, the best hypothesis about ` +
        `the root cause, and what decision or access is needed.`,
      attempts,
    };
  }

  const convergence = isConverging(attempts);
  if (!convergence.converging) {
    return {
      allowed: false,
      reason:
        `Not converging — ${convergence.reason} Stop here even though ` +
        `${MAX_ATTEMPTS - attempts.length} attempt(s) remain. Thrash is a signal, ` +
        `not a phase to push through.`,
      attempts,
    };
  }

  return { allowed: true, attempt: attempts.length + 1, attempts };
}

export function record(entry) {
  const attempts = readAttempts(entry.failureKey);
  const row = {
    ...entry,
    attempt: attempts.length + 1,
    at: new Date().toISOString(),
  };
  mkdirSync(dirname(HEALING_LOG), { recursive: true });
  appendFileSync(HEALING_LOG, JSON.stringify(row) + '\n');
  return row;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const command = process.argv[2];

  if (command === 'check-fix') {
    const file = arg('--diff-file');
    const diff = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
    const { isEscalation, violations } = classifyFix(diff);
    if (isEscalation) {
      console.error('This is an escalation, not a fix. It weakens the check:\n');
      for (const v of violations) console.error(`  - ${v.id}: ${v.why}`);
      console.error(
        '\nIf this is the only fix available, say so and escalate. Do not commit it ' +
          'as a fix.\n'
      );
      process.exit(1);
    }
    console.log('No banned weakening patterns found. (A tripwire, not a proof.)');
    process.exit(0);
  }

  if (command === 'status') {
    const key = arg('--key');
    if (!key) {
      console.error('status needs --key');
      process.exit(1);
    }
    const state = canAttempt(key);
    console.log(`failure: ${key}`);
    console.log(`attempts recorded: ${state.attempts.length}/${MAX_ATTEMPTS}`);
    for (const a of state.attempts) {
      console.log(`  ${a.attempt}. ${a.outcome} — ${a.diagnosis ?? '(no diagnosis)'}`);
    }
    console.log(
      state.allowed
        ? `\nAttempt ${state.attempt} permitted.`
        : `\nSTOP: ${state.reason}`
    );
    process.exit(state.allowed ? 0 : 1);
  }

  if (command === 'record') {
    const key = arg('--key');
    const outcome = arg('--outcome');
    if (!key || !['fixed', 'failed', 'escalated'].includes(outcome)) {
      console.error('record needs --key and --outcome fixed|failed|escalated');
      process.exit(1);
    }
    const outputFile = arg('--output-file');
    const row = record({
      failureKey: key,
      command: arg('--command', ''),
      exitCode: Number(arg('--exit', '1')),
      output: outputFile ? readFileSync(outputFile, 'utf8') : '',
      diagnosis: arg('--diagnosis'),
      fixSummary: arg('--fix'),
      outcome,
      escalationReason: arg('--escalation-reason'),
    });
    console.log(`recorded attempt ${row.attempt} for "${key}": ${outcome}`);
    process.exit(0);
  }

  console.error(
    'usage: self-heal.mjs <record|status|check-fix> [...]\n' +
      'See the header of this file for the bounds these commands enforce.'
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

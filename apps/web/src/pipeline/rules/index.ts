/**
 * Runner for the generated-code rule registry.
 *
 * Both existing call sites go through this: tools/read-logs.ts turns findings
 * into errors that drive the Coder's repair loop, and finalize-generation.ts
 * turns them into warnings on the finished run. Detection is shared so the two
 * can no longer drift; severity stays each caller's decision.
 */

import type { ProjectFile } from '@bicameral/shared/types';
import { RULES } from './registry.js';
import type { RuleId, Violation } from './types.js';

export type { Rule, RuleId, Violation } from './types.js';
export { RULES } from './registry.js';

export interface RuleRunOptions {
  /** Run only these rules. Defaults to all of them. */
  readonly only?: readonly RuleId[];
  /** Skip these rules. Applied after `only`. */
  readonly skip?: readonly RuleId[];
}

/** Run every applicable rule over every file. */
export function runRules(
  files: readonly ProjectFile[],
  options: RuleRunOptions = {}
): Violation[] {
  const skip = new Set(options.skip ?? []);
  const active = RULES.filter(
    (r) =>
      (options.only === undefined || options.only.includes(r.id)) &&
      !skip.has(r.id)
  );

  const violations: Violation[] = [];
  for (const file of files) {
    for (const rule of active) {
      violations.push(...rule.check(file));
    }
  }
  return violations;
}

/** Render violations the way the repair loop wants them: one line, with the line number. */
export function formatViolations(violations: readonly Violation[]): string[] {
  return violations.map((v) =>
    v.line === null
      ? `${v.path}: ${v.message}`
      : `${v.path}:${v.line}: ${v.message}`
  );
}

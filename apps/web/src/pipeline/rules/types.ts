/**
 * Generated-code rule registry — types.
 *
 * Modelled on Controller-C's farkleRules.ts: each rule is a small pure
 * function over source text, declared once with a stable id, and run before
 * anything expensive. Two properties are what make that design worth porting:
 *
 *   - Rules are pure string checks, so they run inside the Worker. tsc, the
 *     build and the test suite all need a shell and a Durable Object has no
 *     child_process, so those stay in CI. Catching a truncated file inline —
 *     before the user is shown a broken app — is worth far more than catching
 *     it minutes later in a pipeline.
 *   - Every violation carries a line number. The repair loop hands failures
 *     back to the model, and "line 214" repairs far more reliably than "this
 *     file contains a placeholder somewhere".
 *
 * This replaces two divergent copies of the same logic: tools/read-logs.ts
 * (4 stub patterns, surfaced as errors that drive repair) and
 * finalize-generation.ts (3 patterns, surfaced as warnings). The second was
 * silently weaker — it never matched `stub` or `not implemented`. Detection is
 * now shared; each call site still chooses its own severity.
 */

import type { ProjectFile } from '@bicameral/shared/types';

export type RuleId =
  | 'no_truncation_marker'
  | 'no_placeholder_stub'
  | 'no_empty_file'
  | 'no_stub_sized_module'
  | 'no_inlined_secret'
  | 'no_direct_provider_call'
  | 'balanced_delimiters'
  | 'valid_json'
  | 'no_require_in_module';

export interface Violation {
  readonly ruleId: RuleId;
  readonly path: string;
  readonly message: string;
  /** 1-indexed. Null when the finding is about the file as a whole. */
  readonly line: number | null;
}

export interface Rule {
  readonly id: RuleId;
  readonly description: string;
  /** Returns every violation in this file, or an empty array when clean. */
  readonly check: (file: ProjectFile) => Violation[];
}

/** Locate the 1-indexed line a character offset falls on. */
export function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

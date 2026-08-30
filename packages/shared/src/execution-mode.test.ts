/**
 * Pins the retirement of `dangerously_automated`.
 *
 * The mode declared "auto-advance, no safety pauses, no logging" and did none
 * of it: `shouldPauseAtGate` is the entire gate decision and reads
 * `mode === 'ask_first'`, so every non-ask_first mode behaved the same. It was
 * deleted rather than implemented — the one thing it promised beyond
 * `auto_accept` was suppressing the record, and a pipeline that automates
 * itself without a record is one no audit can reconstruct.
 *
 * What is asserted here is the migration path, because that is the part that
 * can silently go wrong: `execution_mode` is a TEXT column with no constraint,
 * so rows written before the deletion still hold the old string, and requests
 * from an integration that has not been updated still send it.
 */

import { describe, it, expect } from 'vitest';
import { normalizeExecutionMode, RETIRED_EXECUTION_MODE } from './types';

describe('normalizeExecutionMode', () => {
  it('passes the two live modes through', () => {
    expect(normalizeExecutionMode('ask_first')).toBe('ask_first');
    expect(normalizeExecutionMode('auto_accept')).toBe('auto_accept');
  });

  it('maps the retired mode to auto_accept, which is what it actually did', () => {
    // Not ask_first. Those runs auto-advanced; sending an in-flight one back to
    // a gate would leave it waiting on an approval nobody knows to give.
    expect(normalizeExecutionMode(RETIRED_EXECUTION_MODE)).toBe('auto_accept');
  });

  it('falls back to ask_first for anything unrecognised', () => {
    // An unknown mode is not a reason to stop asking. Null and undefined are
    // both reachable: the column is nullable, and the request body field is
    // optional.
    for (const input of [null, undefined, '', 'AUTO_ACCEPT', 'yolo']) {
      expect(normalizeExecutionMode(input)).toBe('ask_first');
    }
  });

  it('still defaults to ask_first, which is a §7 constraint', () => {
    expect(normalizeExecutionMode(undefined)).toBe('ask_first');
  });
});

/**
 * Pins the removal of the VDR ceiling figure.
 *
 * 91.3 was the simulator's `target_vdr` input — a number somebody typed into
 * simulation/butterfly_report*.json — and this package exported it as
 * `vdrCeiling`, quoted it inside a system-instruction string as "67.7% of
 * 91.3% ceiling", and derived a `vdr_gap` of 23.6 from it. None of that
 * measured the system; it measured the input. There is no production VDR
 * measurement to replace it with, so the passages that leaned on it now state
 * the simulated result and stop.
 *
 * The assertions below are deliberately on the exported *values* and the
 * prompt *strings*, not on the source text. The source still names 91.3 once
 * per site, in a comment recording that the figure was removed and why —
 * that tombstone is the thing most likely to stop someone adding it back, so
 * a test that forbade the string would delete its own defence.
 */

import { describe, it, expect } from 'vitest';
import {
  NS3_SYSTEM_INSTRUCTION,
  POETIC_EQUATION_GAPS,
} from './ns3-system-instruction';
import { EVOLVED_SYSTEM_PROMPT, ISLAND_PROMPTS } from './evolved-system-prompt';
import { V6_RESULTS } from './implementation-plan';

/** Anything a model could read as a stated bound on quality. */
const CEILING_WORDS = /\bceiling\b|\bcap\b|\bmax(?:imum)? (?:vdr|quality)\b/i;

describe('no VDR ceiling reaches a prompt', () => {
  const prompts: Array<[string, string]> = [
    ['NS3_SYSTEM_INSTRUCTION', NS3_SYSTEM_INSTRUCTION],
    ['EVOLVED_SYSTEM_PROMPT', EVOLVED_SYSTEM_PROMPT],
    ...Object.entries(ISLAND_PROMPTS).map(
      ([island, prompt]) =>
        [`ISLAND_PROMPTS.${island}`, String(prompt)] as [string, string]
    ),
  ];

  it('is asserting against prompts that actually exist', () => {
    // Guard against the failure this test already had once: importing a name
    // that does not exist yields undefined, every assertion below passes
    // vacuously, and the suite reports green while checking nothing. Nothing
    // typechecks this package, so the import will not catch it either.
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    for (const [name, prompt] of prompts) {
      expect(prompt, `${name} is empty or missing`).toMatch(/\S/);
    }
  });

  it.each(prompts)('%s does not quote 91.3', (_name, prompt) => {
    expect(prompt).not.toContain('91.3');
  });

  it.each(prompts)(
    '%s does not describe a quality ceiling at all',
    (_name, prompt) => {
      expect(prompt).not.toMatch(CEILING_WORDS);
    }
  );
});

describe('no exported value carries the figure', () => {
  // Walks the whole object rather than naming fields, so a ceiling
  // reintroduced under a different key still fails.
  const numbers = (value: unknown): number[] =>
    typeof value === 'number'
      ? [value]
      : value !== null && typeof value === 'object'
        ? Object.values(value).flatMap(numbers)
        : [];

  it.each([
    ['POETIC_EQUATION_GAPS', POETIC_EQUATION_GAPS as unknown],
    ['V6_RESULTS', V6_RESULTS as unknown],
  ])(
    '%s exports neither 91.3 nor the 23.6 gap derived from it',
    (_name, value) => {
      const found = numbers(value);
      expect(
        found.length,
        'walked nothing — is the export name still right?'
      ).toBeGreaterThan(0);
      expect(found).not.toContain(91.3);
      expect(found).not.toContain(23.6);
    }
  );

  it('keeps the gaps that are measured against a real bound', () => {
    // The point was never to delete the gap analysis. Every remaining entry is
    // a distance from 1.0, which is a bound that means something.
    expect(POETIC_EQUATION_GAPS.task_completion_gap).toBeCloseTo(0.14);
    expect(POETIC_EQUATION_GAPS.gap_closure_gap).toBeCloseTo(0.59);
    expect('vdr_gap' in POETIC_EQUATION_GAPS).toBe(false);
  });
});

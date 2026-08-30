/**
 * The signal colour belongs to the review gate, and to nothing else.
 *
 * Appendix B.2 states the rule: magenta is the signal colour and appears at
 * most twice on a surface; "a third magenta element means the rule is broken."
 * B.7 carries it into the product and names the claimant: "magenta stays
 * scarce — the review gate is the obvious claimant, pick one more at most."
 *
 * A constraint nobody can violate by accident is a constraint that does not
 * need a test. This one is violated by writing a plausible line of CSS —
 * `color: var(--sur-checkpoint)` on any element that wants to look important —
 * and the violation is invisible in review because each individual use looks
 * reasonable. So it is measured instead: this reads the stylesheet and asserts
 * every rule that claims the signal token belongs to the gate.
 *
 * It is deliberately a source-text test rather than a rendered-DOM one. The
 * rule is about what the design system permits, not about what one screen
 * happens to render on one code path, and a rendered test would pass simply by
 * not being at a gate.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** The signal role in both themes: terracotta on parchment, magenta on void.
 * Same token, so the same rule covers both. */
const SIGNAL_TOKENS = ['--sur-checkpoint', '--mkt-magenta', '--mkt-signal'];

/**
 * Whether a declaration block *spends* the signal colour rather than merely
 * re-naming it.
 *
 * `--mkt-signal: var(--mkt-magenta)` is an alias definition, and the marketing
 * surface has a whole scoped block of them under `.mkt`. Counting those as
 * claimants reports the token's own plumbing as a design violation. A spend is
 * a real property — `color`, `background`, `border-color` — reading the token;
 * anything assigned to a name starting with `--` is a rename.
 */
function spendsSignal(body: string): boolean {
  return body.split(';').some((declaration) => {
    const colon = declaration.indexOf(':');
    if (colon === -1) return false;
    const property = declaration.slice(0, colon).trim();
    if (property.startsWith('--')) return false;
    return SIGNAL_TOKENS.some((token) =>
      new RegExp(`var\\(\\s*${token}`).test(declaration.slice(colon + 1))
    );
  });
}

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

/**
 * Every selector whose declaration block reads a signal token.
 *
 * Crude on purpose — it splits on `}` and keeps blocks that mention the token,
 * which over-reports (a selector list counts once per selector) rather than
 * under-reporting. A scarcity check that errs toward finding too much is the
 * right direction for the error to run in.
 */
function selectorsClaimingSignal(css: string): string[] {
  const claiming: string[] = [];
  // Comments first, and this file is full of them: a `/* … */` sitting above a
  // rule is part of the text preceding its `{`, so without this the "selector"
  // for `.review-gate` is four lines of prose about Appendix A.3 — and the
  // prose mentions the class names, which would make the check pass for the
  // wrong reason.
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const brace = block.indexOf('{');
    if (brace === -1) continue;
    const selector = block.slice(0, brace);
    const body = block.slice(brace + 1);
    if (spendsSignal(body)) {
      claiming.push(
        ...selector
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
  }
  return claiming;
}

describe('the generation surface spends its signal colour on the gate', () => {
  const css = read('generation-view.css');
  const claimants = selectorsClaimingSignal(css);

  it('spends it somewhere — an unused signal role is a design that dropped it', () => {
    // The failure mode opposite to overuse: §3.4 asks for the gate to be the
    // centre of the experience, and a gate rendered in the same chrome as
    // every other panel has not been made central, it has been described as
    // central in a comment.
    expect(claimants.length).toBeGreaterThan(0);
  });

  it('gives every claimant to the review gate', () => {
    // `.review-gate*` is the panel; `.pipe-rail__stage--gate*` is the same
    // gate's stage in the rail. Two elements, one gate — which is exactly the
    // allowance B.2 grants, and the second one is not a second claimant so
    // much as the first one saying where it is.
    const stray = claimants.filter(
      (selector) =>
        !/^\.review-gate/.test(selector) &&
        !/^\.pipe-rail__stage--gate/.test(selector)
    );
    expect(stray).toEqual([]);
  });

  it('claims it from at most two distinct components', () => {
    const components = new Set(
      claimants.map((selector) => selector.split(/[\s:]/)[0].split('__')[0])
    );
    expect(components.size).toBeLessThanOrEqual(2);
  });
});

describe('the marketing surface keeps the rule it set', () => {
  const claimants = selectorsClaimingSignal(read('marketing.css'));

  it('never spends the signal colour on more than two components', () => {
    // B.2: "reserved for the human review gate and the highlighted pricing
    // tier. Nowhere else." This asserts the count rather than the names, since
    // the marketing surface predates this test and its class names are its
    // own; what must not drift is how many things claim the scarcest colour.
    //
    // Measured on 2026-08-30: exactly one — `.mkt-card--accent`, which is the
    // variant both named surfaces use. Its two descendant rules are the same
    // component, which is why this counts components rather than selectors.
    const components = new Set(
      claimants.map((selector) => selector.split(/[\s:>]/)[0].split('__')[0])
    );
    expect([...components].sort()).toEqual(['.mkt-card--accent']);
  });

  it('spends it at all — the marketing surface is where the rule was set', () => {
    expect(claimants.length).toBeGreaterThan(0);
  });
});

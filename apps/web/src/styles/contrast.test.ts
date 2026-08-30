/**
 * Contrast, computed from the stylesheet on every run.
 *
 * `tokens/contrast-matrix.md` already documents ratios for the app's token
 * ramps — computed properly, in August, by a script that is not in this
 * repository and does not run in CI. That is a measurement, and it is exactly
 * the kind that goes stale silently: nothing fails when someone nudges a hex
 * value, and the document keeps asserting the old number. The wiring kit's
 * four AA failures are what that looks like in practice — they shipped in a
 * prototype that looked, to the eye, entirely fine.
 *
 * So this reads `dual-theme.css` itself, resolves both themes, and recomputes.
 * Nothing here is transcribed from a table; a wrong comment in the CSS cannot
 * make this pass, and changing a colour is the thing that makes it fail.
 *
 * Standard is WCAG 2.1: sRGB → linearised relative luminance →
 * (L1 + 0.05) / (L2 + 0.05).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  fileURLToPath(new URL('./dual-theme.css', import.meta.url)),
  'utf8'
);

/** AA for body text. The threshold that actually governs readable copy. */
const AA_BODY = 4.5;
/** AA for large text and UI boundaries. */
const AA_LARGE = 3.0;

// ---------------------------------------------------------------- colour --

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return (
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b)
  );
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

// ------------------------------------------------------------------ CSS --

/**
 * Pull the declarations out of one rule block.
 *
 * Deliberately crude and deliberately not a CSS parser: a parser would happily
 * resolve a token this test cannot see, and the point is to read the same text
 * a reviewer reads.
 */
function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  expect(
    start,
    `selector ${selector} is present in dual-theme.css`
  ).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', start);
  const end = CSS.indexOf('\n}', open);
  const body = CSS.slice(open + 1, end);

  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (match?.[1] && match[2]) out[match[1]] = match[2].trim();
  }
  return out;
}

/** Hex-valued tokens only. rgba() lines are alpha overlays, not text colours. */
function hexTokens(rules: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rules).filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v))
  );
}

const parchment = hexTokens(block(':root {'));
const void_ = hexTokens(block(":root[data-theme='dark'],"));
const systemDark = hexTokens(
  block(":root:not([data-theme='light']):not([data-theme='libra']) {")
);

/**
 * The tokens that carry text or a control label, and therefore owe 4.5:1.
 *
 * `*-bright` is excluded on purpose and the exclusion is the design: those are
 * hover and active values, used where the background has also changed, so the
 * body-text threshold is not the applicable one. Excluding them is a rule
 * about what they are for, not a way of getting a failing colour past this
 * test — each still owes AA_LARGE below.
 */
const TEXT_TOKENS = [
  '--sur-ink',
  '--sur-ink-muted',
  '--sur-ink-faint',
  '--sur-contour',
  '--sur-benchmark',
  '--sur-checkpoint',
] as const;

const GROUNDS = ['--sur-ground', '--sur-ground-2', '--sur-ground-3'] as const;

const THEMES = [
  { name: 'parchment (light, default)', tokens: parchment },
  { name: 'void (explicit dark)', tokens: void_ },
  { name: 'void (system dark)', tokens: systemDark },
] as const;

describe.each(THEMES)('$name', ({ tokens }) => {
  it('defines every role token', () => {
    for (const token of [...TEXT_TOKENS, ...GROUNDS]) {
      expect(tokens[token], `${token} is defined`).toBeDefined();
    }
  });

  it.each(GROUNDS)('every text token clears AA body on %s', (ground) => {
    const bg = tokens[ground]!;
    for (const token of TEXT_TOKENS) {
      const r = ratio(tokens[token]!, bg);
      expect(
        r,
        `${token} (${tokens[token]}) on ${ground} (${bg}) is ${r.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it('every -bright variant still clears AA large on the base ground', () => {
    const bg = tokens['--sur-ground']!;
    const brights = Object.keys(tokens).filter((t) => t.endsWith('-bright'));
    expect(
      brights.length,
      'there are -bright variants to check'
    ).toBeGreaterThan(0);
    for (const token of brights) {
      const r = ratio(tokens[token]!, bg);
      expect(
        r,
        `${token} (${tokens[token]}) on ${bg} is ${r.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('text on the signal colour is readable', () => {
    // The signal is a filled background (the review gate, the highlighted
    // tier), so what matters there is the label sitting on it.
    const r = ratio(tokens['--sur-on-signal']!, tokens['--sur-checkpoint']!);
    expect(
      r,
      `on-signal over checkpoint is ${r.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

describe('the two dark definitions', () => {
  it('agree token for token', () => {
    // A colour must never be defined ONLY inside a media query, and the
    // duplicate is how that is achieved — which is worth nothing if the two
    // copies drift. This is the check that keeps the duplication honest.
    expect(systemDark).toEqual(void_);
  });
});

describe('the corrections the audit asked for', () => {
  // Named individually because each is a specific value that specifically
  // failed. A general threshold test would pass again if someone restored the
  // old hex alongside a new token that happens to clear.
  it.each([
    ['--sur-ink-faint', '#8f8d80'],
    ['--sur-contour', '#2f7d77'],
    ['--sur-benchmark', '#9a7322'],
    ['--sur-checkpoint', '#bf5a3f'],
  ])('%s is not back to the failing %s', (token, failing) => {
    expect(parchment[token]?.toLowerCase()).not.toBe(failing);
  });

  it('keeps the failing values available as -bright, not deleted', () => {
    // They are not bad colours; they are colours that fail as body text. The
    // audit said to keep them for hover and active, and losing them would
    // flatten the interaction states.
    expect(parchment['--sur-contour-bright']).toBeDefined();
    expect(parchment['--sur-benchmark-bright']).toBeDefined();
    expect(parchment['--sur-checkpoint-bright']).toBeDefined();
  });
});

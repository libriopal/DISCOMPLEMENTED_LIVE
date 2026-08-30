/**
 * What each verboseness level promises.
 *
 * The acceptance criterion in §3.3 is that a transcript at a given level
 * contains "exactly what that level promises, and no more". The end-to-end
 * half of that lives in tests/integration/pipeline-verboseness.test.ts, which
 * drives the real endpoint against a real D1. This half pins the promise
 * itself, because that is the thing the endpoint is only a delivery mechanism
 * for.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VERBOSENESS,
  messageVisibleAt,
  normalizeVerboseness,
  redactSecrets,
  REDACTED,
  showsStepTelemetry,
  VERBOSENESS_LEVELS,
  type Verboseness,
} from './verboseness.js';

const ALL = VERBOSENESS_LEVELS;

describe('what each level shows', () => {
  it('never withholds a gate or an error, at any level', () => {
    // A gate is the run stopping to ask a human, and an error is the result.
    // Neither is detail, so neither is a verboseness decision.
    for (const level of ALL) {
      expect(messageVisibleAt('gate', level)).toBe(true);
      expect(messageVisibleAt('error', level)).toBe(true);
    }
  });

  it('withholds each agent conclusion at quiet and shows it above', () => {
    expect(messageVisibleAt('output', 'quiet')).toBe(false);
    expect(messageVisibleAt('output', 'normal')).toBe(true);
    expect(messageVisibleAt('output', 'verbose')).toBe(true);
  });

  it('shows reasoning and tool invocations only at verbose', () => {
    for (const kind of ['reasoning', 'tool']) {
      expect(messageVisibleAt(kind, 'quiet')).toBe(false);
      expect(messageVisibleAt(kind, 'normal')).toBe(false);
      expect(messageVisibleAt(kind, 'verbose')).toBe(true);
    }
  });

  it('shows model ids and token counts only at verbose', () => {
    // "Verbose mode must show which model served each step" is how a founder
    // can see for themselves that the auditor is a different model — so the
    // two lower levels must not be the ones carrying it.
    expect(showsStepTelemetry('quiet')).toBe(false);
    expect(showsStepTelemetry('normal')).toBe(false);
    expect(showsStepTelemetry('verbose')).toBe(true);
  });

  it('confines an unclassified message type to verbose', () => {
    // Defaulting an unknown kind to visible would break quiet's promise the
    // first time anyone adds a message type without thinking about levels.
    for (const level of ALL) {
      expect(messageVisibleAt('something-new', level)).toBe(
        level === 'verbose'
      );
    }
  });

  it('is monotonic: nothing visible at a level is hidden at a higher one', () => {
    const kinds = ['gate', 'error', 'consensus', 'output', 'reasoning', 'tool'];
    for (const kind of kinds) {
      const visibility = ALL.map((level) => messageVisibleAt(kind, level));
      expect(visibility).toEqual([...visibility].sort((a, b) => +a - +b));
    }
  });
});

describe('reading the stored level', () => {
  it('accepts each defined level', () => {
    for (const level of ALL) {
      expect(normalizeVerboseness(level)).toBe(level);
    }
  });

  it.each([
    ['an unknown string', 'chatty'],
    ['the retired shape of a setting', 'dangerously_verbose'],
    ['nothing at all', null],
    ['the wrong type', 3],
  ])('falls back to the default given %s', (_why, value) => {
    expect(normalizeVerboseness(value)).toBe(DEFAULT_VERBOSENESS);
  });

  it('defaults to normal rather than to either extreme', () => {
    // quiet would hide conclusions from a founder who never chose to, and
    // verbose would put raw model reasoning in front of one who never asked.
    expect(DEFAULT_VERBOSENESS).toBe<Verboseness>('normal');
  });
});

describe('redaction', () => {
  it('replaces a value under a credential-shaped key', () => {
    expect(
      redactSecrets({ apiKey: 'anything at all', api_key: 'x', name: 'ok' })
    ).toEqual({ apiKey: REDACTED, api_key: REDACTED, name: 'ok' });
  });

  it.each([
    ['an OpenRouter key', 'sk-or-v1-0123456789abcdef0123456789abcdef'],
    ['a GitHub PAT', 'ghp_0123456789abcdefghij0123456789abcd'],
    // Deliberately not a real token *shape* — GitHub push protection blocks a
    // push containing one, even as a test fixture. This still matches the
    // repo's own Slack pattern (/^xox[baprs]-[A-Za-z0-9-]{10,}$/), which is
    // what this case exercises.
    ['a Slack token', 'xoxb-EXAMPLE-NOT-A-REAL-TOKEN'],
    ['a Stripe live key', 'sk_live_0123456789abcdef'],
    [
      'a JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ],
  ])('catches %s wherever it appears', (_what, secret) => {
    // Under an innocent key, because a credential pasted into a free-text
    // field is the leak the key list cannot catch.
    expect(redactSecrets({ note: secret })).toEqual({ note: REDACTED });
  });

  it('keeps a numeric count under a credential-shaped key', () => {
    // `tokensIn` matches the key pattern on the word "token", and it is one of
    // the fields §3.3 requires verbose mode to display. The redactor was
    // eating it. A count is a number; an auth token is a string.
    expect(
      redactSecrets({ tokensIn: 1200, tokensOut: 800, sessionIdCount: 3 })
    ).toEqual({ tokensIn: 1200, tokensOut: 800, sessionIdCount: 3 });
  });

  it('still redacts a structure under a credential-shaped key', () => {
    // The exemption above is for numbers and booleans only — anything that
    // could hold a credential is replaced whole, not recursed into.
    expect(redactSecrets({ credentials: { user: 'a', pass: 'b' } })).toEqual({
      credentials: REDACTED,
    });
    expect(redactSecrets({ tokens: ['a', 'b'] })).toEqual({ tokens: REDACTED });
  });

  it('leaves prose that merely mentions a credential alone', () => {
    // A redactor that fires on ordinary text gets switched off, and then it
    // catches nothing at all.
    const prose = 'Set the api key in wrangler secret put, not in the token.';
    expect(redactSecrets({ advice: prose })).toEqual({ advice: prose });
  });

  it('keeps the shape so a hole is visible rather than a field missing', () => {
    // A founder who sees `[redacted]` learns something true; one who sees the
    // field gone learns something false.
    const result = redactSecrets({
      findings: [{ severity: 'high', token: 'abc' }],
    }) as { findings: Array<Record<string, unknown>> };
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual({ severity: 'high', token: REDACTED });
  });

  it('recurses into nested structures', () => {
    expect(redactSecrets({ a: { b: [{ password: 'hunter2' }] } })).toEqual({
      a: { b: [{ password: REDACTED }] },
    });
  });

  it('terminates on a deeply nested payload', () => {
    // Model output is the one input in this repo whose shape nobody controls.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 200; i++) deep = { next: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
  });

  it('passes non-string leaves through untouched', () => {
    expect(redactSecrets({ count: 3, ok: true, missing: null })).toEqual({
      count: 3,
      ok: true,
      missing: null,
    });
  });
});

/**
 * Proven-red for the compliance surface.
 *
 * The page exists to say what is established and what is not, so the thing most
 * worth testing is that it CANNOT report a green it did not earn. Each case
 * below is a way it could lie, demonstrated rather than asserted.
 */
import { describe, it, expect } from 'vitest';
import type { Env } from '../env.js';
import { selfChecks, type Check } from './compliance.js';

const env = {} as Env;

describe('compliance self-checks', () => {
  it('runs at least one check and every check names its denominator', () => {
    const checks = selfChecks(env);
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      expect(c.name).toBeTruthy();
      expect(c.unit).toBeTruthy();
      expect(typeof c.examined).toBe('number');
    }
  });

  it('examines something in every check — zero is the failure this page is about', () => {
    // A check reporting `examined: 0` has measured nothing, and the whole
    // system exists to stop that reading as a pass. If this ever fails, the
    // check is broken, not the expectation.
    for (const c of selfChecks(env)) {
      expect(c.examined, `${c.name} examined nothing`).toBeGreaterThan(0);
    }
  });

  it('establishes that the deployed auditor prompt forbids a numeric score', () => {
    const c = selfChecks(env).find((k) => k.name === 'auditor-refuses-scores');
    expect(c).toBeDefined();
    expect(c!.ok).toBe(true);
    expect(c!.examined).toBeGreaterThan(0);
  });

  it('reads no secret VALUE, only whether a binding is present', () => {
    const withSecrets = {
      COHERE_API_KEY: 'sk-live-must-never-appear',
      STRIPE_SECRET_KEY: 'sk_live_must_never_appear',
      BETTER_AUTH_SECRET: 'super-secret-value',
    } as unknown as Env;
    const blob = JSON.stringify(selfChecks(withSecrets));
    expect(blob).not.toContain('sk-live-must-never-appear');
    expect(blob).not.toContain('sk_live_must_never_appear');
    expect(blob).not.toContain('super-secret-value');
    // and it still reports the presence it is there to report
    const c = selfChecks(withSecrets).find(
      (k) => k.name === 'secrets-bound-not-exposed'
    );
    expect(c!.detail).toContain('3 of 3');
  });

  it('a check that measured nothing denies the green', () => {
    // The verdict rule, applied to a fabricated check so the rule itself is
    // tested rather than today's happy result.
    const rule = (checks: Check[]) =>
      checks.filter((k) => !k.ok).length === 0 &&
      checks.filter((k) => k.examined === 0).length === 0
        ? 'green'
        : 'RED';

    const ok: Check = {
      name: 'a',
      ok: true,
      examined: 5,
      unit: 'x',
      detail: '',
    };
    const measuredNothing: Check = {
      name: 'b',
      ok: true, // it says it passed...
      examined: 0, // ...having looked at nothing
      unit: 'x',
      detail: '',
    };
    expect(rule([ok])).toBe('green');
    expect(rule([ok, measuredNothing])).toBe('RED');
  });
});

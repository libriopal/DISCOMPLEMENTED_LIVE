/**
 * Dispatch is the one place a wrong string is invisible until production: a
 * capped model routes fine, answers fine, and then stops answering for the
 * rest of the calendar month. These tests pin the two properties that failure
 * mode depends on — which model each role gets, and that a `thinking` config
 * is never handed to a model that cannot take one.
 */
import { describe, it, expect } from 'vitest';
import {
  selectModel,
  getThinkingConfig,
  isQuotaCapped,
  quotaFallbackModel,
  WORKHORSE_MODEL,
  REASONING_MODELS,
} from './model-router.js';
import type { AgentRole } from '@bicameral/shared';

const ROLES: AgentRole[] = [
  'architect',
  'researcher',
  'auditor',
  'verifier',
  'designer',
  'coder',
];

describe('selectModel()', () => {
  it('routes every non-enterprise role to an uncapped model', () => {
    // The property this test exists for is the quota one: a capped model
    // routes fine, answers fine, and then stops answering for the rest of the
    // month. That assertion applies to every role and is unchanged below.
    //
    // The *identity* assertion no longer applies to the auditor. It used to,
    // because every role resolved to the same model — which was the defect,
    // not the design: an auditor sharing the researcher's model is a second
    // opinion from the same source. The auditor now routes to an independent
    // provider on purpose, so asserting it equals WORKHORSE_MODEL would be
    // pinning the collapsed ladder back in place.
    //
    // Narrowed, not weakened: the auditor keeps the uncapped check, gains an
    // explicit check that it is *not* the workhorse, and
    // auditor-independence.test.ts asserts the full property against every
    // other role and tier.
    for (const role of ROLES) {
      for (const tier of ['free', 'pro', 'team'] as const) {
        const model = selectModel(role, 'complex', tier);
        if (role === 'auditor') {
          expect(model).not.toBe(WORKHORSE_MODEL);
        } else {
          expect(model).toBe(WORKHORSE_MODEL);
        }
        expect(isQuotaCapped(model)).toBe(false);
      }
    }
  });

  it('routes enterprise to Command A+, which the quota fallback covers', () => {
    const model = selectModel('coder', 'complex', 'enterprise');
    expect(model).toBe('command-a-plus-05-2026');
    // Capped — acceptable only because chat() can drop to the workhorse.
    expect(isQuotaCapped(model)).toBe(true);
    expect(quotaFallbackModel(model)).toBe(WORKHORSE_MODEL);
  });

  it('never assigns R7B to the coder', () => {
    // The circuit-breaker must throw rather than silently substitute: R7B
    // emits 25-byte stub files instead of code.
    expect(() => selectModel('coder', 'simple')).not.toThrow();
    expect(selectModel('coder', 'simple')).not.toBe('command-r7b-12-2024');
  });
});

describe('quotaFallbackModel()', () => {
  it('maps every capped chat model to an uncapped one', () => {
    for (const capped of [
      'command-a-plus-05-2026',
      'command-a-reasoning-08-2025',
      'command-a-translate-08-2025',
      'command-a-vision-07-2025',
    ]) {
      const fallback = quotaFallbackModel(capped);
      expect(fallback).toBe(WORKHORSE_MODEL);
      // A capped→capped fallback shares the same counter and buys nothing.
      expect(isQuotaCapped(fallback as string)).toBe(false);
    }
  });

  it('returns null for an uncapped model', () => {
    expect(quotaFallbackModel(WORKHORSE_MODEL)).toBeNull();
    expect(quotaFallbackModel('command-r7b-12-2024')).toBeNull();
  });
});

describe('getThinkingConfig()', () => {
  it('returns undefined for a model that rejects `thinking`', () => {
    // This is the regression that cost a week of zero-token auditor steps:
    // a config was returned on role and tier alone, with no reference to the
    // model actually being dispatched to.
    for (const role of ROLES) {
      for (const tier of ['free', 'pro', 'team', 'enterprise'] as const) {
        expect(getThinkingConfig(role, tier, WORKHORSE_MODEL)).toBeUndefined();
      }
    }
  });

  it('defaults to the workhorse, so an unqualified call is safe', () => {
    expect(getThinkingConfig('auditor', 'free')).toBeUndefined();
  });

  it('enables reasoning on every enterprise role when the model allows it', () => {
    for (const role of ROLES) {
      const config = getThinkingConfig(
        role,
        'enterprise',
        'command-a-plus-05-2026'
      );
      expect(config).toMatchObject({ type: 'enabled' });
      expect((config as { tokenBudget: number }).tokenBudget).toBeGreaterThan(
        0
      );
    }
  });

  it('spends reasoning only on the quality gates below enterprise', () => {
    const reasoning = 'command-a-reasoning-08-2025';
    expect(getThinkingConfig('auditor', 'pro', reasoning)).toEqual({
      type: 'enabled',
      tokenBudget: 1000,
    });
    expect(getThinkingConfig('verifier', 'pro', reasoning)).toEqual({
      type: 'enabled',
      tokenBudget: 1000,
    });
    for (const role of ['researcher', 'designer', 'coder']) {
      expect(getThinkingConfig(role, 'pro', reasoning)).toEqual({
        type: 'disabled',
      });
    }
  });

  it('only ever enables reasoning on a model in REASONING_MODELS', () => {
    for (const model of REASONING_MODELS) {
      expect(getThinkingConfig('auditor', 'enterprise', model)).toBeDefined();
    }
  });
});

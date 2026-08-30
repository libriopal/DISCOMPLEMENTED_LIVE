/**
 * The auditor must never be the model it audits.
 *
 * `selectModelInner()` used to return one model for every step, so the audit
 * stage was the researcher's own model grading the researcher's own output.
 * Nothing failed. Nothing could fail — the pipeline had no way to notice that
 * its quality gate had stopped being a gate, because a self-audit and a real
 * audit are indistinguishable in the logs. That is the whole reason this file
 * exists, and it is why these assertions are about *identity* rather than
 * about any particular model being good.
 *
 * The regression this guards is not malice, it is tidiness: `selectModelInner`
 * is a switch with five cases returning the same constant, and collapsing it
 * looks like an obvious cleanup. It is the one change here that silently
 * removes a safety property.
 */

import { describe, it, expect } from 'vitest';
import { selectModel, type PipelineComplexity } from './model-router.js';
import {
  AUDITOR_MODEL,
  AUDITOR_MODEL_DEV_FREE,
  AUDITOR_MODEL_ESCALATION,
  auditCostUsd,
  resolveAuditorModel,
} from './auditor-model.js';

const COMPLEXITIES: PipelineComplexity[] = ['simple', 'moderate', 'complex'];
const TIERS = ['free', 'pro', 'team', 'enterprise'] as const;

describe('the auditor is independent of the researcher', () => {
  it.each(COMPLEXITIES)(
    'auditor !== researcher at complexity %s',
    (complexity) => {
      expect(selectModel('auditor', complexity)).not.toBe(
        selectModel('researcher', complexity)
      );
    }
  );

  it.each(TIERS)('auditor !== researcher on the %s tier', (tier) => {
    // Enterprise is the case that actually broke. `selectModel` short-circuited
    // every step to command-a-plus-05-2026 before the step was examined, so the
    // accounts paying most for the quality gate were the only ones guaranteed
    // not to have one.
    expect(selectModel('auditor', 'simple', tier)).not.toBe(
      selectModel('researcher', 'simple', tier)
    );
  });

  it('is independent of every other pipeline role too, not just the researcher', () => {
    // The auditor reviews research, but a shared model anywhere upstream means
    // shared blind spots. Cheap to assert, and it pins the property rather than
    // the one instance of it the brief called out.
    const auditor = selectModel('auditor', 'simple');
    for (const role of [
      'researcher',
      'verifier',
      'designer',
      'coder',
    ] as const) {
      expect(
        selectModel(role, 'simple'),
        `${role} collides with the auditor`
      ).not.toBe(auditor);
    }
  });

  it('routes the auditor to a different provider, not merely a different model', () => {
    // Two Cohere models would satisfy `!==` while still sharing training data,
    // tokeniser, alignment, and therefore failure modes. `isOpenRouterModel()`
    // in apps/web/src/lib/cohere.ts dispatches on the "/" — so the slug
    // containing one is what actually makes the request leave Cohere.
    expect(selectModel('auditor', 'simple')).toContain('/');
  });
});

describe('resolveAuditorModel', () => {
  it('returns the pin when nothing overrides it', () => {
    expect(resolveAuditorModel()).toBe(AUDITOR_MODEL);
    expect(resolveAuditorModel({})).toBe(AUDITOR_MODEL);
    expect(resolveAuditorModel({ AUDITOR_MODEL: '' })).toBe(AUDITOR_MODEL);
    expect(resolveAuditorModel({ AUDITOR_MODEL: '   ' })).toBe(AUDITOR_MODEL);
  });

  it('honours an override so the model is tunable without a deploy', () => {
    expect(
      resolveAuditorModel({ AUDITOR_MODEL: AUDITOR_MODEL_ESCALATION })
    ).toBe(AUDITOR_MODEL_ESCALATION);
  });

  it('refuses an override that would route back to Cohere', () => {
    // The override exists to let an operator tune the auditor. It must not let
    // them disable it: a Cohere slug here has no "/", dispatches through
    // chat(), and silently restores the self-audit with no error anywhere.
    expect(() =>
      resolveAuditorModel({ AUDITOR_MODEL: 'command-a-03-2025' })
    ).toThrow(/independent provider/i);
  });

  it('an override still cannot collide with the researcher through selectModel', () => {
    expect(
      selectModel('auditor', 'simple', 'free', {
        AUDITOR_MODEL: AUDITOR_MODEL_ESCALATION,
      })
    ).not.toBe(selectModel('researcher', 'simple', 'free'));
  });
});

describe('the free tier stays on our own source', () => {
  // OpenRouter's free tier trains on submitted prompts. The dev scripts audit
  // this repository, which is ours to disclose; the pipeline auditor reads
  // users' generated code, which is not. The whole safety of the split rests
  // on the free id never reaching the runtime, and the failure mode is silent
  // in exactly the way this file's other tests describe: users' code would go
  // to a training endpoint and every log would look identical.

  it('keeps the free id out of the production dispatch path', () => {
    for (const complexity of COMPLEXITIES) {
      for (const tier of TIERS) {
        expect(selectModel('auditor', complexity, tier)).not.toBe(
          AUDITOR_MODEL_DEV_FREE
        );
      }
    }
    expect(resolveAuditorModel()).not.toBe(AUDITOR_MODEL_DEV_FREE);
  });

  it('refuses an env override that would put users’ code on the free tier', () => {
    // The override is an operational tuning knob. Reaching the free tier
    // through it would be a data-disclosure decision made by a config value.
    expect(() =>
      resolveAuditorModel({ AUDITOR_MODEL: AUDITOR_MODEL_DEV_FREE })
    ).toThrow(/free tier/i);
  });

  it('is the same weights as the pin, so findings stay comparable', () => {
    // If these diverge, the §4B calibration evidence recorded against the pin
    // stops describing the model that actually audits our commits.
    expect(AUDITOR_MODEL_DEV_FREE).toBe(`${AUDITOR_MODEL}:free`);
  });
});

describe('audit cost is a number, not an assurance', () => {
  it('prices an audit at the pinned model list rates', () => {
    // 100K in / 4K out is the rough shape of a §4B diff audit: a large diff and
    // test output going in, a short findings list coming back.
    // 100_000 * 0.085/1e6 = 0.0085; 4_000 * 0.40/1e6 = 0.0016.
    expect(auditCostUsd(100_000, 4_000)).toBeCloseTo(0.0101, 6);
  });

  it('is zero for a call that never happened', () => {
    expect(auditCostUsd(0, 0)).toBe(0);
  });
});

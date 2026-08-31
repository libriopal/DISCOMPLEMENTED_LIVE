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
  AUDITOR_BASE_URL,
  AUDITOR_MODEL,
  AUDITOR_MODEL_ESCALATION,
  AUDITOR_PRICING_USD_PER_MTOK,
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

describe('the provider is NVIDIA, directly', () => {
  // Until 2026-08-30 the auditor was reached through OpenRouter, and the
  // safety property that needed testing was that OpenRouter's `:free` tier —
  // which trains on submitted prompts — could never be reached from the
  // runtime, because the runtime submits users' generated code. That whole
  // split is gone: the direct endpoint has one tier and no `:free` suffix.
  //
  // What replaced it as the thing worth pinning is narrower and still real —
  // the endpoint has to be NVIDIA's, and a stale `:free` override has to fail
  // at config time rather than 404 per call.

  it('points at NVIDIA and not at a router', () => {
    expect(AUDITOR_BASE_URL).toBe('https://integrate.api.nvidia.com/v1');
    expect(AUDITOR_BASE_URL).not.toContain('openrouter');
    // `apps/web/src/lib/cohere.ts` routes on the vendor prefix, so a pin that
    // stopped carrying it would silently go back out over OpenRouter's key.
    expect(AUDITOR_MODEL.startsWith('nvidia/')).toBe(true);
    expect(AUDITOR_MODEL_ESCALATION.startsWith('nvidia/')).toBe(true);
  });

  it('refuses a leftover :free override rather than 404ing per call', () => {
    // NVIDIA does not serve `:free`. Left alone the call fails per chunk and
    // the audit scripts record each one as "unreachable" — an audit that
    // reports itself incomplete for what reads as a network fault.
    expect(() =>
      resolveAuditorModel({ AUDITOR_MODEL: `${AUDITOR_MODEL}:free` })
    ).toThrow(/:free|NVIDIA/i);
  });
});

describe('audit cost is not asserted, because it is not published', () => {
  it('reports no per-token price rather than an invented one', () => {
    // OpenRouter listed $0.085 / $0.40 per Mtok, so a run could report a
    // figure that matched a line on a bill. NVIDIA Build publishes none and
    // the API returns none. Ground rule 2: no number in this repo that has no
    // reproducible derivation in this repo. The budget moved to tokens, which
    // the endpoint does report — see scripts/auditor-provider.mjs.
    expect(AUDITOR_PRICING_USD_PER_MTOK).toBeNull();
  });
});

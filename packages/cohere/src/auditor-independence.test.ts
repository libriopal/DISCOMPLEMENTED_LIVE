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
  AUDITOR_REASONING_EFFORT,
  auditorBaseUrlFor,
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

  it('points at Workers AI and not at a router', () => {
    // Re-pinned 2026-09-22 to @cf/zai-org/glm-5.3-flash. The assertion that
    // matters is unchanged in kind: the auditor is reached DIRECTLY, at a
    // named provider, and never through a router that could silently serve it
    // from the same family as the researcher.
    expect(AUDITOR_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
    expect(AUDITOR_BASE_URL).not.toContain('openrouter');
    // `apps/web/src/lib/cohere.ts` routes on the vendor prefix, so a pin that
    // stopped carrying it would silently go back out over OpenRouter's key —
    // an `@cf/` slug contains a "/" and satisfies the OpenRouter test too.
    expect(AUDITOR_MODEL.startsWith('@cf/')).toBe(true);
    expect(AUDITOR_MODEL_ESCALATION.startsWith('@cf/')).toBe(true);
    // Still not Cohere, which is the property this whole file protects.
    expect(AUDITOR_MODEL).not.toContain('command');
    expect(AUDITOR_MODEL).not.toContain('north');
  });

  it('pins a reasoning effort, because omitting it returns nothing', () => {
    // Not a preference. glm-5.3 treats reasoning_effort as mandatory and
    // defaults to 'max', at which it exhausts max_tokens reasoning and
    // returns an EMPTY message with finish_reason 'length'. Measured on this
    // account: 120.6s / 0 characters at the default, against 14.5s and a
    // correct verdict at 'low'. An auditor that returns nothing is the exact
    // failure this file exists to prevent, wearing a timeout as a disguise.
    expect(AUDITOR_REASONING_EFFORT).toBeTruthy();
    expect(['low', 'high', 'max']).toContain(AUDITOR_REASONING_EFFORT);
  });

  it('builds a per-account endpoint and refuses a malformed account id', () => {
    // The account id is part of the PATH on Cloudflare, so it cannot be a
    // constant in a public repo, and a wrong one must fail loudly rather than
    // producing a URL that 404s per call.
    expect(auditorBaseUrlFor('0'.repeat(32))).toBe(
      `${AUDITOR_BASE_URL}/accounts/${'0'.repeat(32)}/ai/v1`
    );
    expect(() => auditorBaseUrlFor('not-an-account')).toThrow(/32-hex/i);
    expect(() => auditorBaseUrlFor('')).toThrow(/32-hex/i);
  });

  it('refuses a leftover :free override rather than 404ing per call', () => {
    // Neither NVIDIA nor Workers AI serves `:free`; it is an OpenRouter-ism.
    // Left alone the call fails per chunk and the audit scripts record each
    // one as "unreachable" — an audit that reports itself incomplete for what
    // reads as a network fault.
    expect(() =>
      resolveAuditorModel({ AUDITOR_MODEL: `${AUDITOR_MODEL}:free` })
    ).toThrow(/:free|NVIDIA/i);
  });
});

describe('audit cost is asserted only because it is published', () => {
  it('carries the provider-published rate, not an estimate', () => {
    // This was `null` for a good reason and is a number for the same reason.
    // NVIDIA Build publishes no per-token list price and its API returns none,
    // so any figure would have been unreproducible — ground rule 2. Cloudflare
    // publishes the rate in its own model catalogue
    // (GET /accounts/{id}/ai/models/search), so the figure is derivable by
    // anyone with an account, which is what the rule actually asks for.
    expect(AUDITOR_PRICING_USD_PER_MTOK).toEqual({ input: 0.15, output: 0.5 });
  });

  it('prices the escalation model as strictly costlier, or it is not an escalation', () => {
    // A documented upgrade path that is cheaper than the default would mean
    // the default was the wrong pin. Recorded as a relationship rather than a
    // second hardcoded number.
    expect(AUDITOR_MODEL_ESCALATION).not.toBe(AUDITOR_MODEL);
    expect(AUDITOR_MODEL_ESCALATION.startsWith('@cf/zai-org/')).toBe(true);
  });
});

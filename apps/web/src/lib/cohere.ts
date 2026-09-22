/**
 * Cohere proxy — free-first model routing for the 4-agent pipeline.
 * `selectModel(step, complexity)` maps a pipeline step to its model
 * (@bicameral/cohere/model-router); `callModel()` dispatches the chat
 * request to the right provider and normalizes any per-model quirks so
 * callers never branch on provider or model. See @agent_docs/cohere-integration.md.
 *
 * OpenRouter (`callOpenRouter`) is still available for genuinely
 * OpenRouter-only models, but nothing in the pipeline routes there today —
 * North Mini Code (the one model that used to) is called directly through
 * Cohere's own API instead (see model-router.ts for why).
 */
import {
  chat,
  type ChatRequest,
  type ChatResponse,
} from '@bicameral/cohere/chat';
import {
  callOpenAICompatible,
  callOpenRouter,
} from '@bicameral/cohere/openrouter';
import {
  AUDITOR_BASE_URL,
  AUDITOR_REASONING_EFFORT,
  auditorBaseUrlFor,
} from '@bicameral/cohere/auditor-model';
import {
  selectModel,
  getThinkingConfig,
  type PipelineComplexity,
} from '@bicameral/cohere/model-router';
import type { CohereResponse } from '@bicameral/cohere';
import type { AgentRole } from '@bicameral/shared/types';
import type { Env } from '../env.js';

export { selectModel, getThinkingConfig };
export type { PipelineComplexity };

function isOpenRouterModel(model: string): boolean {
  return model.includes('/') || model.endsWith(':free');
}

/**
 * Models served by NVIDIA directly rather than through OpenRouter.
 *
 * Only the auditor is here today (`nvidia/nemotron-3-*`, see
 * packages/cohere/src/auditor-model.ts). The test is the vendor prefix rather
 * than an equality check against the pin, because `AUDITOR_MODEL` in
 * wrangler.toml can move the pin to the escalation model or to another
 * Nemotron without a deploy — and a routing rule that silently stops applying
 * when the pin moves would send the auditor's traffic to OpenRouter with an
 * NVIDIA-only key and 401.
 */
function isNvidiaModel(model: string): boolean {
  return model.startsWith('nvidia/');
}

/**
 * Models served by Cloudflare Workers AI.
 *
 * The auditor pin moved here on 2026-09-22 (see auditor-model.ts for the
 * re-resolution and the measurements). `@cf/...` slugs contain a "/" and would
 * otherwise satisfy `isOpenRouterModel` and be sent to OpenRouter with a
 * Cloudflare token — a 401 per call, recorded as "auditor unreachable", which
 * reads as a network problem rather than a routing bug. Same reasoning as the
 * NVIDIA branch, and ordered before OpenRouter for the same reason.
 *
 * Prefix rather than equality against the pin, so moving `AUDITOR_MODEL` to
 * the escalation model via wrangler.toml does not silently disable the route.
 */
function isWorkersAiModel(model: string): boolean {
  return model.startsWith('@cf/');
}

// North models 400 on `response_format: json_object` — unlike R7B/Command A,
// which need it for reliable JSON output. Confirmed directly against the
// live API during Phase 9 testing.
function isNorthModel(model: string): boolean {
  return model.startsWith('north-');
}

/** Routes a chat request to the provider that serves `model`, normalizing
 * both into the same CohereResponse<ChatResponse> shape. */
export async function callModel(
  model: string,
  request: Omit<ChatRequest, 'model'>,
  env: Env
): Promise<CohereResponse<ChatResponse>> {
  const fullRequest: ChatRequest = { ...request, model };
  if (isNorthModel(model)) {
    delete fullRequest.responseFormat;
    // Cohere Labs' own model card (huggingface.co/CohereLabs/North-Mini-Code-1.0,
    // verified 2026-08-12) states this model's generation quality was
    // calibrated at temperature=1.0, top_p=0.95 — overriding whatever the
    // caller passed (coder.ts previously hardcoded 0.2, a low-temperature
    // trick meant for models relying on response_format for JSON compliance,
    // which North can't use — see the delete above). Running this model
    // outside its documented sampling point is a real, verified contributor
    // to malformed/degenerate output, not just theory.
    fullRequest.temperature = 1.0;
    fullRequest.topP = 0.95;
  }

  // Ordered before the OpenRouter branch: an `nvidia/` slug satisfies both
  // tests (it contains a "/"), and before 2026-08-30 it took the OpenRouter
  // path. The auditor now has its own account.
  if (isWorkersAiModel(model)) {
    // Reasoning effort is PINNED, not defaulted. glm-5.3 treats it as
    // mandatory and defaults to 'max', at which it reasons past any sane
    // max_tokens and returns an empty message with finish_reason 'length'.
    // Measured: 120.6s and zero characters of answer, against 14.5s and a
    // correct verdict at 'low'. See AUDITOR_REASONING_EFFORT.
    const withEffort = {
      ...fullRequest,
      reasoningEffort: AUDITOR_REASONING_EFFORT,
    } as ChatRequest & { reasoningEffort: string };
    // Both halves are needed and each is reported by the name that is
    // missing. The account id is part of the endpoint PATH, so an absent one
    // cannot be papered over with a header — but it is NOT a secret, and
    // conflating the two would send someone hunting for the wrong thing.
    // An empty key falls through to callOpenAICompatible's own unset-key
    // refusal, which is the message that already exists for this case.
    const account = env.CF_ACCOUNT_ID ?? '';
    return callOpenAICompatible(withEffort, {
      label: 'Workers AI',
      baseUrl: /^[0-9a-f]{32}$/.test(account)
        ? auditorBaseUrlFor(account)
        : AUDITOR_BASE_URL,
      apiKey: env.CF_API_TOKEN ?? '',
      keyVar: /^[0-9a-f]{32}$/.test(account) ? 'CF_API_TOKEN' : 'CF_ACCOUNT_ID',
      codePrefix: 'WORKERS_AI',
    });
  }

  if (isNvidiaModel(model)) {
    return callOpenAICompatible(fullRequest, {
      label: 'NVIDIA',
      baseUrl: AUDITOR_BASE_URL,
      apiKey: env.NVIDIA_API_KEY,
      keyVar: 'NVIDIA_API_KEY',
      codePrefix: 'NVIDIA',
    });
  }

  if (isOpenRouterModel(model)) {
    return callOpenRouter(fullRequest, {
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL,
    });
  }

  return chat(fullRequest, {
    COHERE_API_KEY: env.COHERE_API_KEY,
    COHERE_API_BASE: env.COHERE_BASE_URL,
  });
}

/** Convenience wrapper: picks the model for `step`/`complexity` and calls it. */
/**
 * `tier` was missing from this signature, so `selectModel`'s third argument was
 * never supplied and its `if (tier === 'enterprise')` branch — the only path to
 * command-a-plus-05-2026 — was unreachable through the agent pipeline.
 * Enterprise accounts were silently served the same model as pro.
 *
 * The tier was already in scope at every call site (runAuditor, runVerifier and
 * runDesigner take a `tier` parameter; researcher and coder read it off their
 * context object and already use it for `getThinkingConfig`). Only this
 * function had nowhere to put it.
 *
 * Passing nothing keeps the previous behaviour, so tier-less callers are
 * unaffected: `selectModel` falls through to `selectModelInner` for every tier
 * except enterprise.
 */
export async function callAgentModel(
  step: AgentRole,
  complexity: PipelineComplexity,
  request: Omit<ChatRequest, 'model'>,
  env: Env,
  tier?: 'free' | 'pro' | 'team' | 'enterprise'
): Promise<CohereResponse<ChatResponse>> {
  // `env` is passed so the auditor's AUDITOR_MODEL override is honoured at the
  // point of dispatch. Every site that *records* which model ran must pass it
  // too, or the label drifts from reality the moment an override is set.
  const model = selectModel(step, complexity, tier, env);
  // `thinking` is decided here rather than at the call sites, because it is a
  // function of the model far more than of the role: command-a-03-2025 (every
  // non-enterprise dispatch since 2026-08-27) rejects the parameter outright,
  // while Command A+ on enterprise accepts it. The agents used to pass
  // getThinkingConfig(role, tier) without a model and could not know which
  // they were talking to.
  return callModel(
    model,
    { ...request, thinking: getThinkingConfig(step, tier, model) },
    env
  );
}

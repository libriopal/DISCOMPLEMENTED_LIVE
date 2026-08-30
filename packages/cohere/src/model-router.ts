/**
 * @bicameral/cohere/model-router — which Cohere model each agent dispatches to.
 *
 * ## Why the workhorse is Command A and not a reasoning model
 *
 * Cohere meters two different things, and only one of them is a rate limit.
 * From docs.cohere.com/docs/rate-limits (fetched 2026-08-27):
 *
 *   "Trial keys (and prod keys on newer Chat model variants) are limited to
 *    1,000 API calls a month."
 *
 * That page then splits the Chat models into two production groups:
 *
 *   | Model                       | Production limit    | 1,000/mo cap |
 *   | command-a-03-2025           | 500 req/min         | no           |
 *   | command-r-08-2024           | 500 req/min         | no           |
 *   | command-r-plus-08-2024      | 500 req/min         | no           |
 *   | command-r7b-12-2024         | 500 req/min         | no           |
 *   | north-mini-code             | 500 req/min         | no           |
 *   | command-a-plus-05-2026      | contact sales@      | YES          |
 *   | command-a-reasoning-08-2025 | contact sales@      | YES          |
 *   | command-a-translate/vision  | contact sales@      | YES          |
 *
 * The key on this account is a production key. That does not exempt it: the
 * cap follows the *model variant*, so every model this router used to hand out
 * — command-a-reasoning-08-2025 for all five non-enterprise agents, and
 * command-a-plus-05-2026 for enterprise — sat on the capped side of that line.
 * A five-agent run spends at least five calls, so 1,000 calls a month is on the
 * order of 200 runs across the entire product before every tier stops at once.
 * Measured 2026-08-25: an enterprise run died at step 1 with
 * `429 "You are past the per-month request limit for this model"`.
 *
 * command-a-03-2025 is the way out. It is the same $2.50/M input, $10.00/M
 * output as the two capped models (Cohere no longer publishes current-gen
 * per-token rates; see the cost note below), has a 256K context and an 8K
 * output ceiling that the Coder's maxTokens: 8192 already matches, and carries
 * the full 500 req/min production limit with no monthly cap. Switching costs
 * nothing per token and removes the ceiling that was ending runs.
 *
 * ## What is given up
 *
 * command-a-03-2025 does not support the `thinking` parameter. The Aug 21 2026
 * switch to command-a-reasoning-08-2025 was made to get reasoning on the
 * Auditor and Verifier quality gates, and that is the one capability lost here.
 * It was not actually being delivered: the `thinking` object was serialised
 * with a camelCase `tokenBudget` until 2026-08-26 (commit 7dcb6b1), so every
 * reasoning-enabled step was rejected with a 422 rather than reasoning. The
 * production `pipeline_steps` rows agree — every auditor step recorded against
 * command-a-reasoning-08-2025 has tokens_in = 0 and tokens_out = 0.
 *
 * Reasoning stays reachable through REASONING_MODELS below for anything that
 * deliberately opts in and can absorb the cap.
 *
 * ## STRICT POLICY
 *
 * R7B (command-r7b-12-2024, 7B params) is NEVER assigned to the Coder — it
 * produces 25-byte stub files instead of real code.
 */
import type { AgentRole } from '@bicameral/shared';
import { resolveAuditorModel } from './auditor-model.js';

export type PipelineComplexity = 'simple' | 'moderate' | 'complex';

/** The subset of Env `selectModel` needs to resolve the auditor's model. */
export interface AuditorModelEnv {
  AUDITOR_MODEL?: string;
}

/** Models that must NEVER be used for code generation. */
const BANNED_CODER_MODELS = new Set([
  'command-r7b-12-2024', // 7B params — produces stub files
]);

/**
 * The model every agent dispatches to unless something deliberately opts out.
 * Uncapped on a production key, 256K context, 8K max output.
 */
export const WORKHORSE_MODEL = 'command-a-03-2025';

/**
 * Chat models Cohere caps at 1,000 calls a month even on a production key,
 * mapped to the uncapped model to retry with when that cap is hit.
 *
 * Both entries fall back to the workhorse rather than to each other: they are
 * capped by the same counter, so a capped→capped retry buys nothing.
 */
const QUOTA_CAPPED_MODELS = new Map<string, string>([
  ['command-a-plus-05-2026', WORKHORSE_MODEL],
  ['command-a-reasoning-08-2025', WORKHORSE_MODEL],
  ['command-a-translate-08-2025', WORKHORSE_MODEL],
  ['command-a-vision-07-2025', WORKHORSE_MODEL],
]);

/**
 * Models that accept the `thinking` parameter. Sending it to anything else is
 * a 422, so getThinkingConfig() consults this before returning a config and
 * the quota fallback strips `thinking` when it downgrades.
 */
export const REASONING_MODELS = new Set([
  'command-a-reasoning-08-2025',
  'command-a-plus-05-2026',
]);

/** True when `model` is subject to Cohere's 1,000-calls-a-month cap. */
export function isQuotaCapped(model: string): boolean {
  return QUOTA_CAPPED_MODELS.has(model);
}

/**
 * The uncapped model to retry with after a COHERE_MONTHLY_QUOTA_EXHAUSTED, or
 * null when `model` is already uncapped and the 429 means something else.
 *
 * This is the enterprise fallback. Until 2026-08-27 there deliberately was
 * none: serving an enterprise account the standard model is a product
 * decision, not an error-handling one, and it was not mine to make. Johnathan
 * made it — an enterprise run that stops at step 1 is worth less to the
 * account holder than the same run completed on Command A.
 */
export function quotaFallbackModel(model: string): string | null {
  return QUOTA_CAPPED_MODELS.get(model) ?? null;
}

export function selectModel(
  step: AgentRole,
  complexity: PipelineComplexity = 'simple',
  tier?: 'free' | 'pro' | 'team' | 'enterprise',
  env?: AuditorModelEnv
): string {
  // The auditor is resolved before the tier branch, not inside it. Enterprise
  // used to short-circuit every step to Command A+, which would have put the
  // auditor back on the researcher's own provider for exactly the accounts
  // paying most for the gate. Independence is not a tier feature.
  if (step === 'auditor') {
    return resolveAuditorModel(env);
  }

  // Enterprise still reaches for Command A+ first — 128K context, 64K output,
  // and the reasoning the other tiers no longer get. It is quota-capped, so
  // chat() drops to WORKHORSE_MODEL on a monthly-quota 429 rather than letting
  // the run die. The Coder guard below applies to it too: A+ is not banned.
  if (tier === 'enterprise') {
    return 'command-a-plus-05-2026';
  }

  const model = selectModelInner(step, complexity);

  // Hard guard: if the Coder somehow gets a banned model, throw immediately.
  // This is a circuit-breaker, not a fallback — it must never silently pass.
  if (step === 'coder' && BANNED_CODER_MODELS.has(model)) {
    throw new Error(
      `MODEL ROUTING VIOLATION: Coder was assigned banned model "${model}". ` +
        `R7B (7B params) produces stub files. Use Command A or North Mini Code only.`
    );
  }

  return model;
}

function selectModelInner(
  step: AgentRole,
  _complexity: PipelineComplexity
): string {
  switch (step) {
    case 'auditor':
      // Unreachable: selectModel resolves the auditor to an independent
      // provider before it gets here. Kept as a throw rather than deleted
      // because the tempting "simplification" is to fold the auditor back in
      // with the others, and this is where that would land.
      throw new Error(
        'MODEL ROUTING VIOLATION: the auditor reached selectModelInner, which ' +
          'only serves Cohere models. The auditor must not run on the same ' +
          'provider as the researcher it audits — see auditor-model.ts.'
      );
    case 'architect': // legacy — now handled by researcher
    case 'researcher':
    case 'verifier':
    case 'designer':
      return WORKHORSE_MODEL;
    case 'coder':
      // North Mini Code (north-mini-code-1-0) is unresponsive — tested Aug 21
      // 2026, 120s timeout with HTTP 000 (no response). Command A answers a 4K
      // code generation in ~19s and supports response_format: json_object for
      // structured file output, which North Mini Code does not. Its 8K output
      // ceiling is exactly the Coder's configured maxTokens.
      return WORKHORSE_MODEL;
  }
}

/**
 * Reasoning configuration for an agent, or undefined when the model cannot
 * take one.
 *
 * `model` is required because the answer depends on it far more than on the
 * role: every non-enterprise agent now runs on command-a-03-2025, which
 * rejects `thinking` outright. Returning a config the model cannot accept is
 * how the auditor spent a week recording zero-token steps.
 *
 * Enterprise (Command A+): reasoning enabled on all agents.
 * Everything else: undefined — the field is omitted from the request.
 */
export function getThinkingConfig(
  role: string,
  tier: 'free' | 'pro' | 'team' | 'enterprise' = 'free',
  model: string = WORKHORSE_MODEL
): { type: 'enabled'; tokenBudget: number } | { type: 'disabled' } | undefined {
  if (!REASONING_MODELS.has(model)) return undefined;

  if (tier === 'enterprise') {
    const budgetByRole: Record<string, number> = {
      researcher: 1000,
      auditor: 2000,
      verifier: 2000,
      designer: 1000,
      coder: 1500,
      architect: 500,
    };
    return { type: 'enabled', tokenBudget: budgetByRole[role] ?? 1000 };
  }

  // A reasoning-capable model reached by a non-enterprise caller: the quality
  // gates are the two steps worth spending reasoning tokens on.
  if (role === 'auditor' || role === 'verifier') {
    return { type: 'enabled', tokenBudget: 1000 };
  }

  return { type: 'disabled' };
}

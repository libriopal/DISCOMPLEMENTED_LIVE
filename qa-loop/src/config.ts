/**
 * qa-loop config — budget caps, pricing table, and target URLs.
 *
 * Pricing sourced from agent_docs/cohere-integration.md (read at build time,
 * not fetched live) — see that file's "Model Routing" and "$1,000 Credit
 * Strategy" tables for the underlying numbers:
 *   - North Mini Code: $0 in / $0 out per 1M tokens (free, direct Cohere)
 *   - Command R7B:      $0.0375 in / $0.15 out per 1M tokens
 *   - Command A:         $2.50 in / $10.00 out per 1M tokens
 *   - Embed v4:          ~$0.12 / 1M tokens (input only; embeddings have no
 *                         "output" token cost)
 *   - Rerank v4:          ~$2.00 / 1M search units (~$0.01 per search call
 *                         at typical search-unit counts)
 *
 * Model id strings below match packages/cohere/src/model-router.ts's
 * `selectModel()` return values exactly, since that's what pipeline_steps
 * .model_used actually stores.
 */

export const BUDGET = {
  /** Hard cap for a single pipeline-simulation run (checks/pipelineSimulation.ts). */
  perRunUsd: 1.0,
  /** Hard cap for the whole harness invocation (all Cohere-spending checks combined). */
  totalUsd: 5.0,
} as const;

export interface ModelPricing {
  /** USD per input token (not per 1M — already divided). */
  inputPerToken: number;
  /** USD per output token. */
  outputPerToken: number;
}

export const MODEL_PRICING_USD_PER_1M: Record<
  string,
  { in: number; out: number }
> = {
  'north-mini-code-1-0': { in: 0, out: 0 },
  'command-r7b-12-2024': { in: 0.0375, out: 0.15 },
  'command-a-03-2025': { in: 2.5, out: 10.0 },
  // Embed has no meaningful in/out split — treat the whole embed as "input"
  // tokens for cost purposes (matches how the cohere-integration.md table
  // computes lattice-enrichment cost).
  'embed-v4.0': { in: 0.12, out: 0 },
};

/** Rerank is priced per search unit, not per token — flat estimate per call
 * per agent_docs/cohere-integration.md ("~$0.01/search"). */
export const RERANK_COST_PER_CALL_USD = 0.01;

export function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = MODEL_PRICING_USD_PER_1M[model];
  if (!pricing) return 0; // unknown model — don't guess, surface as 0 + a report note
  return (
    (tokensIn / 1_000_000) * pricing.in + (tokensOut / 1_000_000) * pricing.out
  );
}

/** Local wrangler dev target — NEVER point this at discomplemented.com or
 * the real staging URL (hard boundary #4 in the task spec). */
export const LOCAL_API_BASE_URL =
  process.env.QA_LOOP_LOCAL_URL ?? 'http://127.0.0.1:8787';

/** Read-only reachability check only — no data writes, no auth, no pipeline
 * runs are ever sent here. */
export const LIVE_SITE_URL = 'https://discomplemented.com';

/** D1 database name as declared in apps/web/wrangler.toml. */
export const D1_DATABASE_NAME = 'bicameral';

export const REPO_ROOT = new URL('../../', import.meta.url).pathname;
export const WEB_APP_ROOT = new URL('../../apps/web/', import.meta.url)
  .pathname;

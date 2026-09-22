/**
 * @bicameral/cohere/auditor-model — the independent auditor's model, and the
 * reason it is not a Cohere model.
 *
 * ## Why this file exists
 *
 * `selectModelInner()` returned the same model for every step — researcher,
 * auditor, verifier, designer, coder. The ladder had collapsed, so the audit
 * step was one model grading its own upstream output. That is a second opinion
 * from the same source, not an audit: the failure modes that make a researcher
 * miss something are the same failure modes that make the auditor miss that it
 * was missed. Independence is not a preference here, it is the entire function
 * of the step.
 *
 * The auditor therefore runs on a different provider's model family, reached
 * on NVIDIA's own OpenAI-compatible endpoint (`AUDITOR_BASE_URL` below).
 * It previously routed through OpenRouter; a direct NVIDIA key replaced that
 * on 2026-08-30. Same weights, one less intermediary, and — see the pricing
 * note below — a different answer to "what did this cost".
 *
 * ## How this model was chosen — resolved, not remembered
 *
 * Originally queried `GET https://openrouter.ai/api/v1/models` on
 * **2026-08-29** (396 models listed) and filtered for the Nemotron family.
 * Re-resolved against `GET https://integrate.api.nvidia.com/v1/models` on
 * **2026-08-30** (83 models listed) when the direct key replaced OpenRouter:
 * both ids below are served natively, so the pin did not move. The two
 * credible auditors:
 *
 *   | id                                | ctx  | $/M in | $/M out | reasoning |
 *   | nvidia/nemotron-3-super-120b-a12b | 1M   | 0.085  | 0.40    | yes       |
 *   | nvidia/nemotron-3-ultra-550b-a55b | 262K | 0.50   | 2.20    | yes       |
 *
 * Super is the pin. It is the cheaper of the two by roughly 6x on output, and
 * it has the larger context window — which is the binding constraint for §4B,
 * where the auditor is handed a full staged diff plus the output of
 * `pnpm test:all`. Both advertise `structured_outputs` and `response_format`,
 * which the audit step depends on for schema-compliant findings, and both cap
 * completions at 16,384 tokens.
 *
 * OpenRouter's `:free` variants were rejected deliberately while that was the
 * transport: they are rate-limited and deprioritised, and an auditor that
 * intermittently fails to answer is an auditor that intermittently gets
 * skipped — the exact outcome §4 exists to prevent. The direct endpoint has no
 * free tier and no `:free` suffix, so that whole split is gone (see the note
 * where AUDITOR_MODEL_DEV_FREE used to be).
 *
 * Ultra stays documented above as the escalation option: if calibration shows
 * Super missing planted defects, the fix is a better auditor, not a lower bar.
 *
 * ## Pinned, but configurable without a code change
 *
 * The slug is pinned by exact id — model lists move, and an auditor that
 * silently changes identity between runs makes its own findings
 * uncomparable. `AUDITOR_MODEL` in wrangler.toml `[vars]` overrides it so the
 * model can be tuned or rolled back operationally. Re-resolve against the live
 * list before changing the pin, and re-run the §4B calibration afterwards:
 * changing the auditor invalidates the evidence that the gate works.
 */

/**
 * Re-resolved 2026-09-22 against Cloudflare Workers AI's live catalogue
 * (`GET /accounts/{id}/ai/models/search`, 31 text-generation models), and
 * MEASURED rather than chosen from the listing. Do not edit from memory —
 * re-resolve.
 *
 * The shortlist, with real prices from the catalogue and real latencies from
 * an audit of an actual source file (~1.6K input tokens) on this account:
 *
 *   | model                        | ctx   | $/M in | $/M out | result          |
 *   | @cf/zai-org/glm-5.3-flash    | 1.31M | 0.15   | 0.50    | 14.5s, valid    |
 *   | @cf/nvidia/nemotron-3-120b   | 256K  | 0.50   | 1.50    | 16.2s, valid    |
 *   | @cf/google/gemma-4-26b-a4b   | 256K  | 0.10   | 0.30    | 105s, NO OUTPUT |
 *   | @cf/zai-org/glm-5.3          | 1.31M | 1.40   | 4.40    | costlier twin   |
 *
 * glm-5.3-flash is the pin. It has the LARGEST context window on the
 * catalogue and a larger one than the 1M this pin previously carried — and
 * context is the binding constraint for the 4B gate, which is handed a full
 * staged diff plus the output of `pnpm test:all`. At $0.15/$0.50 it is also
 * the cheapest model that clears that window by a factor of five.
 *
 * Gemma was the obvious cheap candidate and was REJECTED on measurement: it
 * halves the context window, and at default reasoning effort it spent all
 * 8,000 output tokens thinking and returned an EMPTY answer. A model that
 * produces no verdict is not a cheap auditor, it is an unreachable one.
 *
 * Independence still holds, which is the entire function of this step: Z.ai
 * weights, on Cloudflare's infrastructure, auditing a Cohere-native pipeline.
 * Different vendor from the researcher it audits, as before.
 */
export const AUDITOR_MODEL = '@cf/zai-org/glm-5.3-flash';

/**
 * The stronger, costlier sibling — same family, full-size rather than flash.
 * Not the default; the documented upgrade path when calibration says flash is
 * not catching enough. Same 1.31M window, roughly 9x the output price.
 */
export const AUDITOR_MODEL_ESCALATION = '@cf/zai-org/glm-5.3';

/**
 * Reasoning effort, and why this is a PIN rather than a tuning knob.
 *
 * glm-5.3 carries `reasoning_effort: {mandatory: true, default_effort: 'max'}`.
 * At 'max' the model reasons past any sane `max_tokens` and returns
 * `finish_reason: 'length'` with an EMPTY message — measured: 120.6s and zero
 * characters of answer on a file that 'low' audited correctly in 14.5s.
 *
 * So this is load-bearing. Omit it and the auditor does not merely get slower,
 * it stops producing verdicts — and an auditor that returns nothing is the
 * failure this whole step exists to prevent, arriving disguised as a timeout.
 */
export const AUDITOR_REASONING_EFFORT = 'low';

/**
 * Where the auditor is called. NVIDIA's OpenAI-compatible chat-completions
 * endpoint, used directly rather than through OpenRouter.
 *
 * Verified 2026-08-30 with the account's `nvapi-` key: `GET /v1/models`
 * returned 83 models including both ids above, and a `POST /v1/chat/completions`
 * against AUDITOR_MODEL returned 200 with a usage block. No 402.
 */
export const AUDITOR_BASE_URL = 'https://api.cloudflare.com/client/v4';

/**
 * Workers AI's OpenAI-compatible base URL for one account.
 *
 * The account id is part of the PATH on Cloudflare, so unlike the NVIDIA
 * endpoint this cannot be a single constant: it is built per deployment from
 * `CF_ACCOUNT_ID`. It is not a secret (the token is), but it is per-account,
 * and hardcoding one account's id into a public repository would be both wrong
 * and useless to anybody else.
 *
 * Verified 2026-09-22: `POST {base}/chat/completions` with the account's token
 * returned 200 with a `usage` block and a parseable JSON verdict.
 */
export function auditorBaseUrlFor(accountId: string): string {
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    throw new Error(
      'CF_ACCOUNT_ID is not a 32-hex Cloudflare account id, so the auditor ' +
        'endpoint cannot be built. This is the account id, not the token id.'
    );
  }
  return `${AUDITOR_BASE_URL}/accounts/${accountId}/ai/v1`;
}

/*
 * AUDITOR_MODEL_DEV_FREE was removed on 2026-08-30 and is deliberately not
 * replaced.
 *
 * It existed for one reason: OpenRouter's free tier trains on submitted
 * prompts, so the repo's own scripts (auditing our source, ours to disclose)
 * used a `:free` id while the pipeline auditor (auditing users' generated
 * code, not ours to disclose) used the billed one. The split was by what is
 * being audited, not by what is cheaper.
 *
 * The direct NVIDIA endpoint has one tier and no `:free` suffix, so there is
 * no longer a training endpoint to keep users' code away from — and therefore
 * no second id. Anything still importing this name should use AUDITOR_MODEL.
 */

/**
 * What an audit costs, in dollars per million tokens.
 *
 * This was `null` for a stated reason: NVIDIA Build publishes no per-token list
 * price for `integrate.api.nvidia.com` and the endpoint returns none, so any
 * figure here would have been unreproducible — which this repo's ground rules
 * forbid. The bound did not disappear, it changed denomination to tokens.
 *
 * Cloudflare publishes the rate in the model catalogue itself, so the figure is
 * reproducible again by anyone with an account:
 *
 *   GET /accounts/{id}/ai/models/search  ->  @cf/zai-org/glm-5.3-flash
 *                                            $0.15 / M input, $0.50 / M output
 *
 * Read on 2026-09-22. It is a list price from the provider's own API, not an
 * estimate, and a run's `usage` block multiplies straight through it. Callers
 * still budget in tokens; this lets the ledger also report a dollar figure that
 * matches a line on a bill.
 */
export const AUDITOR_PRICING_USD_PER_MTOK = { input: 0.15, output: 0.5 };

/**
 * The auditor's model for this deployment.
 *
 * Reads the `AUDITOR_MODEL` var when set so the model is tunable without a
 * deploy of new code, and falls back to the pin. It deliberately does **not**
 * validate the override against a list of known-good slugs: an operator
 * pinning a model this file has never heard of is the point of the override,
 * and NVIDIA will reject an unknown slug loudly on the first call.
 *
 * What it does enforce is that the override is still a non-Cohere model. A
 * Cohere slug here would route back through `chat()` and quietly restore the
 * self-audit — the one outcome that must not be reachable by configuration.
 */
export function resolveAuditorModel(env?: { AUDITOR_MODEL?: string }): string {
  const override = env?.AUDITOR_MODEL?.trim();
  if (!override) return AUDITOR_MODEL;

  if (!override.includes('/')) {
    throw new Error(
      `AUDITOR_MODEL="${override}" is not a vendor-qualified model id (no "/"), so ` +
        `it would dispatch to Cohere — the same provider as the researcher it audits. ` +
        `The audit step must run on an independent provider. Use a slug like ` +
        `"${AUDITOR_MODEL}".`
    );
  }

  // Kept after the move off OpenRouter, for a narrower reason than before.
  // `:free` is an OpenRouter-ism; NVIDIA's endpoint does not serve it. Left to
  // its own devices the call would 404 per chunk and each one would be recorded
  // as "unreachable" — an audit that reports itself as incomplete for a reason
  // that reads as a network problem. Rejecting the suffix here turns that into
  // one legible error at config time.
  if (override.endsWith(':free')) {
    throw new Error(
      `AUDITOR_MODEL="${override}" carries OpenRouter's ":free" suffix, but the ` +
        `auditor now calls NVIDIA directly (${AUDITOR_BASE_URL}), which does not ` +
        `serve that id. Drop the suffix — use "${AUDITOR_MODEL}".`
    );
  }

  return override;
}

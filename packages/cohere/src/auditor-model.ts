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
 * Resolved 2026-08-29 against OpenRouter's live model list and re-resolved
 * 2026-08-30 against NVIDIA's. See the header for the comparison this came out
 * of. Do not edit from memory — re-resolve.
 */
export const AUDITOR_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

/**
 * The stronger, costlier Nemotron. Not the default; the documented upgrade
 * path when calibration says Super is not catching enough.
 */
export const AUDITOR_MODEL_ESCALATION = 'nvidia/nemotron-3-ultra-550b-a55b';

/**
 * Where the auditor is called. NVIDIA's OpenAI-compatible chat-completions
 * endpoint, used directly rather than through OpenRouter.
 *
 * Verified 2026-08-30 with the account's `nvapi-` key: `GET /v1/models`
 * returned 83 models including both ids above, and a `POST /v1/chat/completions`
 * against AUDITOR_MODEL returned 200 with a usage block. No 402.
 */
export const AUDITOR_BASE_URL = 'https://integrate.api.nvidia.com/v1';

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
 * What an audit costs, in dollars — and why this is `null`.
 *
 * On OpenRouter this was $0.085/$0.40 per Mtok, listed publicly, so a run
 * could report a dollar figure that matched a line on a bill. NVIDIA Build
 * publishes no per-token list price for `integrate.api.nvidia.com`, and the
 * endpoint returns none: `POST /v1/chat/completions` gives `usage`
 * (prompt/completion/total tokens) and no rate.
 *
 * So a dollar figure here would be a number nobody could reproduce, which is
 * exactly what the brief forbids. The bound did not go away — it changed
 * denomination. Callers budget in TOKENS (`--budget-tokens` in
 * scripts/audit-system.mjs), which the endpoint does report and which the
 * scripts can therefore both estimate before a run and measure after one.
 */
export const AUDITOR_PRICING_USD_PER_MTOK = null;

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

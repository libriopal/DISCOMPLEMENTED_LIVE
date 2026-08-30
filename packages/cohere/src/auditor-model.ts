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
 * The auditor therefore runs on a different provider's model family. The
 * OpenRouter transport already existed and was dispatched from nothing;
 * `isOpenRouterModel()` in apps/web/src/lib/cohere.ts routes any slug
 * containing `/` there automatically.
 *
 * ## How this model was chosen — resolved, not remembered
 *
 * Queried `GET https://openrouter.ai/api/v1/models` on **2026-08-29** (396
 * models listed) and filtered for the Nemotron family. Ten variants were
 * available to this account. The two credible auditors:
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
 * The `:free` variants were rejected deliberately. They are rate-limited and
 * deprioritised, and an auditor that intermittently fails to answer is an
 * auditor that intermittently gets skipped — which is the exact outcome §4
 * exists to prevent. Paying $0.085/M to keep the gate reliable is the cheap
 * side of that trade.
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
 * Resolved 2026-08-29 against OpenRouter's live model list. See the header for
 * the comparison this came out of. Do not edit from memory — re-resolve.
 */
export const AUDITOR_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

/**
 * The stronger, costlier Nemotron. Not the default; the documented upgrade
 * path when calibration says Super is not catching enough.
 */
export const AUDITOR_MODEL_ESCALATION = 'nvidia/nemotron-3-ultra-550b-a55b';

/**
 * The same model, on OpenRouter's free tier — **for the repository's own
 * scripts only**. `scripts/audit-diff.mjs` and `scripts/audit-system.mjs` read
 * this; `selectModel` and the Worker do not, and must not.
 *
 * ## Why there are two ids for one model
 *
 * OpenRouter's free tier trains on submitted prompts. The dev scripts submit
 * *this repository's* source, which is ours to disclose. The pipeline auditor
 * submits *users' generated code*, which is not — routing that through a
 * training endpoint would be a disclosure decision made by a constant, on
 * behalf of people who never saw it. So the split is by what is being audited,
 * not by what is cheaper.
 *
 * Same underlying weights (`nvidia/nemotron-3-super-120b-a12b`, 262,144
 * context), so findings from the two auditors stay comparable and the §4B
 * calibration evidence recorded against the paid id still describes the model
 * doing the auditing. Only the billing and data-retention terms differ.
 *
 * Free tier means rate limits are real and hit under normal use. A caller of
 * this id must retry on 429 rather than record an unreachable chunk — see
 * `callAuditor` in `scripts/audit-system.mjs`.
 */
export const AUDITOR_MODEL_DEV_FREE = 'nvidia/nemotron-3-super-120b-a12b:free';

/**
 * USD per million tokens, as listed on 2026-08-29. Used to price an audit so
 * §4A req 4 and §4B req 7 ("cost is bounded, measure it") can be answered with
 * a number rather than an assurance.
 *
 * These are list prices for the pinned model only. A run that overrides
 * `AUDITOR_MODEL` is priced with these rates and will therefore be wrong — the
 * estimate carries the model id so a mismatch is visible rather than silent.
 */
export const AUDITOR_PRICING_USD_PER_MTOK = {
  model: AUDITOR_MODEL,
  input: 0.085,
  output: 0.4,
  resolvedOn: '2026-08-29',
} as const;

/** What one audit cost, in USD, at the pinned model's list price. */
export function auditCostUsd(
  inputTokens: number,
  outputTokens: number
): number {
  const { input, output } = AUDITOR_PRICING_USD_PER_MTOK;
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

/**
 * The auditor's model for this deployment.
 *
 * Reads the `AUDITOR_MODEL` var when set so the model is tunable without a
 * deploy of new code, and falls back to the pin. It deliberately does **not**
 * validate the override against a list of known-good slugs: an operator
 * pinning a model this file has never heard of is the point of the override,
 * and OpenRouter will reject an unknown slug loudly on the first call.
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
      `AUDITOR_MODEL="${override}" is not an OpenRouter model id (no "/"), so it ` +
        `would dispatch to Cohere — the same provider as the researcher it audits. ` +
        `The audit step must run on an independent provider. Use a slug like ` +
        `"${AUDITOR_MODEL}".`
    );
  }

  // The second thing an override must not be able to do. OpenRouter's free
  // tier trains on submitted prompts, and what this auditor submits is the
  // user's generated code — so a `:free` suffix in a config var is a
  // disclosure decision about someone else's work, made by a string nobody
  // reviews. The dev scripts use AUDITOR_MODEL_DEV_FREE directly and never
  // come through here; there is no legitimate route to the free tier from a
  // deployed Worker.
  if (override.endsWith(':free')) {
    throw new Error(
      `AUDITOR_MODEL="${override}" targets OpenRouter's free tier, which trains ` +
        `on submitted prompts. The pipeline auditor submits users' generated ` +
        `code. Use the paid id ("${AUDITOR_MODEL}"); AUDITOR_MODEL_DEV_FREE is ` +
        `for this repository's own scripts auditing this repository's own source.`
    );
  }

  return override;
}

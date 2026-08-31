/**
 * How much of a run the founder is shown.
 *
 * §3.3 asks for three levels, and the levels only mean something if each one's
 * promise is written down somewhere a test can hold it. That is what this
 * module is: the promise, not the rendering.
 *
 *   quiet    stage transitions and the result
 *   normal   the above, plus each agent's conclusion
 *   verbose  the above, plus full agent reasoning, model ids, token counts,
 *            tool invocations, and the auditor's findings
 *
 * Two properties are load-bearing and easy to lose:
 *
 * 1. **Raising the level mid-run reveals what already happened.** It does,
 *    because nothing here is a stream filter over live events — the messages
 *    endpoint re-reads every row from D1 on each poll and filters the whole
 *    history at the level asked for. A higher level on the next poll returns
 *    the rows the lower level withheld. There is no replay to arrange and no
 *    re-run to trigger; the reason is that the record was always complete and
 *    only the projection was narrow.
 *
 * 2. **The level must never decide whether a stage looks finished.** The chat
 *    panel used to derive each agent's status from the presence of that
 *    agent's `output` message. Filtering messages by level would then have
 *    made a quiet run look permanently stuck — a display setting silently
 *    changing what the pipeline appears to have done. Stage status now comes
 *    from `pipeline_steps` and is returned at every level; only the *contents*
 *    narrow. See `routes/pipeline.ts`.
 */

export const VERBOSENESS_LEVELS = ['quiet', 'normal', 'verbose'] as const;

export type Verboseness = (typeof VERBOSENESS_LEVELS)[number];

export const DEFAULT_VERBOSENESS: Verboseness = 'normal';

/**
 * Message kinds, and the lowest level at which each is shown.
 *
 * `error` and `gate` sit at quiet deliberately. A gate is a stage transition —
 * it is the moment the pipeline stopped and asked — and an error is the
 * result. A verboseness setting is a preference about detail; it is not a
 * licence to withhold the fact that a run failed or is waiting on a human.
 */
const MINIMUM_LEVEL: Record<string, Verboseness> = {
  gate: 'quiet',
  error: 'quiet',
  consensus: 'quiet',
  output: 'normal',
  reasoning: 'verbose',
  tool: 'verbose',
};

const RANK: Record<Verboseness, number> = {
  quiet: 0,
  normal: 1,
  verbose: 2,
};

/**
 * `execution_mode`'s lesson applied to a second unconstrained column: read the
 * stored string through a normaliser, never a cast. Anything unrecognised —
 * an older row, a hand-edited setting, a query parameter — becomes the
 * default rather than a level with no defined promise.
 */
export function normalizeVerboseness(value: unknown): Verboseness {
  return VERBOSENESS_LEVELS.includes(value as Verboseness)
    ? (value as Verboseness)
    : DEFAULT_VERBOSENESS;
}

/**
 * Whether a message of this kind is shown at this level.
 *
 * An unknown kind is shown at `verbose` only. A future message type that
 * nobody classified should surface in the level that promises everything, and
 * be absent from the two that promise something narrower — the alternative,
 * defaulting it to visible, would quietly break quiet's promise the first time
 * anyone adds a type.
 */
export function messageVisibleAt(
  messageType: string,
  level: Verboseness
): boolean {
  const minimum = MINIMUM_LEVEL[messageType] ?? 'verbose';
  return RANK[level] >= RANK[minimum];
}

/** Whether per-step model ids, token counts and timings are included. */
export function showsStepTelemetry(level: Verboseness): boolean {
  return level === 'verbose';
}

/**
 * Keys whose values are never shown, whatever the level.
 *
 * Agent metadata is model output plus whatever the pipeline attached to it,
 * and it is returned to the browser wholesale. Nothing in the pipeline puts a
 * credential there today — but "nothing does today" is the same assurance the
 * client bundle had before `tests/security/client-bundle.test.ts` existed, and
 * verbose mode is precisely the setting that would carry one out if it ever
 * changed.
 */
const SECRET_KEY =
  /(api[_-]?key|secret|token|password|passwd|authorization|bearer|credential|private[_-]?key|session[_-]?id|cookie)/i;

/**
 * Value shapes that are a credential regardless of the key they arrive under.
 *
 * Matched against whole strings after trimming, so a sentence that merely
 * mentions a key name is untouched — the aim is to catch a value that leaked
 * into a free-text field, not to censor prose.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI-style, incl. OpenRouter's sk-or-v1-…
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub PAT / OAuth / refresh / server
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  // Slack. `xoxe.` (the refresh/rotation token) uses a dot after the prefix
  // rather than a dash, so it needs the alternation — the token in this
  // repo's .env is an `xoxe.`-prefixed one and the dash-only pattern let it
  // through.
  /^xox[baprse][-.][A-Za-z0-9.-]{10,}$/, // Slack
  // NVIDIA Build (`integrate.api.nvidia.com`), the auditor's provider as of
  // 2026-08-30. Added when the client-bundle test grew an NVIDIA row and a
  // key sitting in a free-text `note` field survived redaction: the key-name
  // rule above only catches values that arrive under a credential-ish key,
  // and a leaked value rarely does.
  /^nvapi-[A-Za-z0-9_-]{20,}$/,
  // Fluxy project/user keys. We issue these ourselves, so the shape is ours
  // to declare; both tiers share it.
  /^fc_[A-Za-z0-9_-]{16,}$/,
  /^(?:whsec|rk_live|sk_live|pk_live)_[A-Za-z0-9]{10,}$/, // Stripe
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, // JWT
];

export const REDACTED = '[redacted]';

function isSecretValue(value: string): boolean {
  const trimmed = value.trim();
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * A number or a boolean, which no credential is.
 *
 * `SECRET_KEY` matches on substrings, so `tokensIn` and `tokensOut` match it
 * on the word "token" — and those two are exactly what §3.3 requires verbose
 * mode to display. The redactor was destroying the thing it exists to protect,
 * caught by `tests/security/client-bundle.test.ts`.
 *
 * Narrowing the pattern to exclude `tokens*` would fix those two names and
 * leave the next count with "secret" or "session" in it broken. This is the
 * general form of the rule: a token *count* is a number, an auth token is a
 * string, and the distinction holds for every key name rather than the two we
 * happened to hit. Objects and arrays under a secret-shaped key are still
 * replaced wholesale, so nothing is weakened for anything that could hold one.
 */
function isCountable(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Removes credential-shaped content from anything bound for the verbose
 * stream.
 *
 * Structure is preserved and only leaf values are replaced, so a redacted
 * payload still renders as itself with a hole in it rather than vanishing —
 * a founder seeing `apiKey: "[redacted]"` learns something true; a founder
 * seeing the field disappear learns something false.
 *
 * Depth is bounded because this runs on model output, which is the one input
 * nobody in this repo controls the shape of.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;

  if (typeof value === 'string') {
    return isSecretValue(value) ? REDACTED : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        SECRET_KEY.test(key) && !isCountable(item)
          ? REDACTED
          : redactSecrets(item, depth + 1);
    }
    return out;
  }

  return value;
}

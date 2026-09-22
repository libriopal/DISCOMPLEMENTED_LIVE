/**
 * scripts/auditor-provider.mjs — where the auditor lives, for the two scripts
 * that call it from a shell.
 *
 * `audit-diff.mjs` (the commit gate) and `audit-system.mjs` (the whole-system
 * pass) each used to carry their own copy of the model pin, the endpoint URL
 * and the key lookup. They drifted immediately: the diff gate read
 * `AUDITOR_MODEL_DEV_FREE` and the system audit read `AUDITOR_MODEL`, so the
 * two produced findings from two different models while both reported "the
 * pinned auditor". Findings that cannot be compared across the two gates are
 * worth less than either gate alone, so the provider is defined once, here.
 *
 * The pin itself still lives in `packages/cohere/src/auditor-model.ts` — the
 * module the Worker imports — and is parsed out of that TypeScript rather than
 * imported. A build step here would make the commit hook depend on a build,
 * which is the wrong dependency direction for a gate: the gate has to be able
 * to run when the build is broken, because that is exactly when it matters.
 *
 * Provider changed 2026-08-30: OpenRouter -> NVIDIA's own OpenAI-compatible
 * endpoint, on a direct `nvapi-` key.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'packages', 'cohere', 'src', 'auditor-model.ts');

/** The environment variable that holds the auditor's credential. */
export const AUDITOR_KEY_VAR = 'NVIDIA_API_KEY';

/**
 * The auditor now lives on Cloudflare Workers AI, so this is not a fallback —
 * it is how the pinned model is reached. `AUDITOR_MODEL` in auditor-model.ts
 * is `@cf/zai-org/glm-5.3-flash`; see that file for the re-resolution and the
 * measurements it came out of.
 *
 * NVIDIA is kept as an override rather than deleted: an environment that still
 * sets `NVIDIA_API_KEY` keeps the auditor it was calibrated against, because
 * findings from two different models are not comparable and a gate whose
 * provider moves without anyone choosing it produces exactly that.
 *
 * Gemma was tried here first and REMOVED on measurement: at default reasoning
 * effort it spent its entire output budget thinking and returned nothing, so a
 * real §4B audit hung until it was killed rather than producing a verdict.
 */
function cfCredentials() {
  const token = (process.env.CF_API_TOKEN || '').trim();
  const account = (process.env.CF_ACCOUNT_ID || '').trim();
  return token && /^[0-9a-f]{32}$/.test(account) ? { token, account } : null;
}

/**
 * Which provider this run will use, decided once so every caller agrees.
 *
 * Order is deliberate: an explicitly configured NVIDIA key always wins, so
 * adding this fallback cannot silently move an existing setup onto a different
 * auditor. Findings from two different models are not comparable, and a gate
 * whose provider changes without anyone choosing it produces exactly that.
 */
export function activeProvider() {
  if (process.env[AUDITOR_KEY_VAR]?.trim()) return 'nvidia';
  return cfCredentials() ? 'cloudflare-workers-ai' : null;
}

/**
 * The reasoning-effort value this run must send, or `null` when the provider
 * takes none. Load-bearing for glm-5.3, which treats it as mandatory and
 * defaults to 'max' — at which it returns an empty message. Read from the pin
 * rather than repeated, for the same reason the model id is.
 */
export function auditorReasoningEffort() {
  if (activeProvider() !== 'cloudflare-workers-ai') return null;
  try {
    return readPin('AUDITOR_REASONING_EFFORT');
  } catch {
    return 'low';
  }
}

/**
 * Read one `export const NAME = '...'` out of auditor-model.ts.
 *
 * Throws rather than defaulting. An auditor that runs against a guessed model
 * because a constant was renamed is an auditor whose findings are attributed
 * to the wrong thing, and the failure would be silent.
 */
function readPin(name) {
  const source = readFileSync(SOURCE, 'utf8');
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(source);
  if (!match) {
    throw new Error(
      `Could not read ${name} from packages/cohere/src/auditor-model.ts. ` +
        'The auditor will not run against a guessed value.'
    );
  }
  return match[1];
}

/** The pinned auditor model — the same id the Worker dispatches. */
export function auditorModel() {
  return readPin('AUDITOR_MODEL');
}

/** Origin + version prefix, no trailing slash. */
export function auditorBaseUrl() {
  const cf = cfCredentials();
  if (activeProvider() === 'cloudflare-workers-ai' && cf) {
    // The account id is part of the PATH on Cloudflare, so the base URL is
    // per-deployment and cannot be a constant in the pin file.
    return `${readPin('AUDITOR_BASE_URL')}/accounts/${cf.account}/ai/v1`;
  }
  return readPin('AUDITOR_BASE_URL');
}

/** The chat-completions URL these scripts POST to. */
export function auditorEndpoint() {
  return `${auditorBaseUrl()}/chat/completions`;
}

/**
 * The key, or `null`.
 *
 * Returns rather than throws so each caller can shape its own refusal: the
 * commit gate wants a message about `AUDIT_SKIP`, and the system audit wants
 * one about every chunk being recorded as unreachable. Neither may proceed
 * without it — a missing key is a refusal, never a clean report.
 */
export function auditorKey() {
  const key = process.env[AUDITOR_KEY_VAR];
  if (key && key.trim()) return key.trim();
  // Only when NVIDIA is absent. See activeProvider(): an explicitly configured
  // key always wins, so this cannot move an existing setup onto another model.
  const cf = cfCredentials();
  return cf ? cf.token : null;
}

/**
 * What a run cost, in dollars — always `null`.
 *
 * On OpenRouter the list price was public ($0.085/$0.40 per Mtok), so the
 * ledger could record a figure that matched a line on a bill. NVIDIA Build
 * publishes no per-token list price for `integrate.api.nvidia.com` and the
 * API returns none: the response carries `usage` and no rate. Inventing a
 * number here would put an unreproducible figure in the audit ledger, which is
 * the specific thing this repo's ground rules forbid.
 *
 * The bound did not disappear, it changed denomination — callers budget in
 * tokens (`--budget-tokens`), which the endpoint does report.
 */
export const COST_USD = null;

/**
 * How long a stream may go silent before the chunk is abandoned.
 *
 * This replaced a 240s ceiling on the WHOLE request on 2026-08-30, and the
 * distinction is the entire point rather than a relaxation.
 *
 * Measured: NVIDIA's shared endpoint takes well over 240s to finish a
 * ~19K-token audit prompt at the 32K output ceiling, because the pinned model
 * reasons at length before it answers. Under the old total-time ceiling every
 * real chunk aborted at 240s and was recorded as "no response — chunk not
 * audited", so a whole-system audit reported zero findings for a reason that
 * had nothing to do with the code. That is the exact failure this script
 * exists to prevent, produced by the script itself.
 *
 * Raising the total ceiling would have hidden the difference between a model
 * that is thinking and a connection that has died — the two look identical
 * from outside a non-streaming request, which is why the ceiling was there.
 * Streaming makes them distinguishable: tokens arriving is evidence of
 * progress, and silence is evidence of a stall. So the timeout now measures
 * silence, which is the thing it was always trying to measure.
 */
export const STREAM_STALL_MS = 120_000;

/**
 * The absolute ceiling, still enforced. A response that dribbles one token
 * every 119 seconds would satisfy the stall timeout forever, and an audit that
 * never ends is an audit that gets killed by whoever is waiting on it — with
 * no report written at all, which is worse than an honest partial one.
 */
export const STREAM_TOTAL_MS = 1_800_000;

/**
 * POST one chat completion and read it as a stream.
 *
 * Returns `{ ok: false, status, bodyText }` for a non-2xx so the caller's own
 * retry policy can decide (both callers retry 429 and 503 and nothing else),
 * and `{ ok: true, content, usage, finishReason }` on success. Network faults,
 * stalls and the total ceiling are thrown as an Error whose `name` is
 * `AuditorStall` when the cause was silence, so a caller can say which.
 */
export async function postChatCompletion({
  key,
  model,
  system,
  user,
  maxTokens,
  temperature = 0.1,
  stallMs = STREAM_STALL_MS,
  totalMs = STREAM_TOTAL_MS,
  onProgress,
}) {
  const controller = new AbortController();
  let stalled = false;
  let idleTimer;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  const totalTimer = setTimeout(() => controller.abort(), totalMs);
  armIdle();

  try {
    const response = await fetch(auditorEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: maxTokens,
        stream: true,
        // Load-bearing, not a tuning knob. glm-5.3 treats reasoning_effort as
        // mandatory and defaults to 'max', at which it reasons past max_tokens
        // and returns an EMPTY message with finish_reason 'length'. Measured:
        // 120.6s and zero characters of answer, against 14.5s and a correct
        // verdict at 'low'. Spread rather than set unconditionally so the
        // NVIDIA override, which takes no such field, sends none.
        ...(auditorReasoningEffort()
          ? { reasoning_effort: auditorReasoningEffort() }
          : {}),
        // Without this the usage block never arrives on a streamed response
        // and every audit records 0 tokens in / 0 out — which is also what a
        // call that never happened records. The budget is denominated in
        // tokens, so a run that cannot count them cannot be bounded.
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = (await response.text()).slice(0, 400);
      return { ok: false, status: response.status, headers: response.headers, bodyText };
    }

    let content = '';
    let usage = {};
    let finishReason = 'unknown';
    let buffer = '';
    const decoder = new TextDecoder();

    for await (const bytes of response.body) {
      armIdle();
      buffer += decoder.decode(bytes, { stream: true });
      // SSE frames are separated by a blank line; a chunk boundary can land
      // mid-frame, so only complete frames are consumed and the remainder is
      // carried forward.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            // A frame this side cannot parse is not a reason to discard the
            // whole audit; the completion is judged below on whether it
            // parsed as JSON, which is the check that matters.
            continue;
          }
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onProgress?.(content.length);
          }
          if (event.choices?.[0]?.finish_reason) {
            finishReason = event.choices[0].finish_reason;
          }
          if (event.usage) usage = event.usage;
        }
      }
    }

    return { ok: true, content, usage, finishReason };
  } catch (err) {
    if (stalled || err.name === 'AbortError' || err.name === 'TimeoutError') {
      const e = new Error(
        stalled
          ? `no output for ${stallMs / 1000}s — chunk not audited`
          : `exceeded the ${totalMs / 1000}s ceiling — chunk not audited`
      );
      e.name = 'AuditorStall';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}

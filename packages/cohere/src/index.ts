/**
 * @bicameral/cohere — Base API client
 * Uses fetch() directly per the standing instruction (no SDK, Cloudflare Workers compatible).
 * All secrets come from env vars — never hardcoded.
 */
import { COHERE_API_BASE, COHERE_ENDPOINTS } from '@bicameral/shared';
import { CohereError } from '@bicameral/shared';

export interface CohereEnv {
  COHERE_API_KEY: string;
  COHERE_API_BASE?: string;
}

export interface CohereResponse<T> {
  data: T;
  requestId: string | null;
  cost: {
    inputTokens: number;
    outputTokens: number;
    billedTokens: number;
  } | null;
  warnings: string[];
}

// Retry configuration for transient Cohere API errors
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 524]);
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 2000;

/**
 * Cohere returns 429 for two unrelated conditions, and only one is transient.
 *
 * A per-minute burst limit clears in seconds and is worth a backoff. A
 * *monthly* call quota does not clear until the calendar rolls over — Cohere
 * caps trial keys, and prod keys on newer chat model variants, at 1,000 calls
 * a month. Retrying that one spends three more calls against the exhausted
 * quota and adds ~14s of latency to a failure that was certain from the first
 * response. Measured in production 2026-08-25: an enterprise pipeline run died
 * at step 1 with `{"message":"You are past the per-month request limit for
 * this model, please wait and try again later."}` — "try again later" is the
 * API's own wording for something no amount of backoff inside one request will
 * fix.
 */
function isMonthlyQuotaError(status: number, body: string): boolean {
  return status === 429 && /per-month|monthly/i.test(body);
}

/**
 * The one 422 that is worth retrying.
 *
 * A 422 from Cohere normally means the request itself is wrong — five wire-shape
 * defects in this repo were found exactly because a malformed body fails loudly
 * and immediately, so 422 must stay off `RETRYABLE_STATUS`. But
 * `NO_VALID_RESPONSE_GENERATED` is not a request defect: it reports that the
 * model produced nothing usable, and Cohere happens to return it with a 422.
 *
 * Measured in production 2026-08-27: two runs of the identical auditor request
 * (same model, same system prompt, same brief), 20 minutes apart — the first
 * died in 295ms with `{"error_type":"NO_VALID_RESPONSE_GENERATED","message":
 * "No valid response generated. Try updating messages"}`, the second returned a
 * complete audit. 295ms is too fast to be a generation attempt at all, and
 * nothing about the messages changed between them, so the API's own advice
 * ("try updating messages") does not apply. One flake at the auditor kills the
 * whole run, and failed runs are already the majority of Cohere spend.
 */
function isTransientGenerationError(status: number, body: string): boolean {
  return status === 422 && /NO_VALID_RESPONSE_GENERATED/.test(body);
}

export async function cohereRequest<T>(
  endpoint: keyof typeof COHERE_ENDPOINTS,
  body: Record<string, unknown>,
  env: CohereEnv,
  options: { signal?: AbortSignal; stream?: boolean } = {}
): Promise<Response> {
  const base = env.COHERE_API_BASE || COHERE_API_BASE;
  const url = `${base}${COHERE_ENDPOINTS[endpoint]}`;

  let lastError: CohereError | null = null;

  // 90s timeout — shorter than Cloudflare's 524 (~100s) so our retry
  // logic kicks in before the CDN returns a 524 that we can't intercept.
  // Uses AbortController + setTimeout for maximum Workers runtime compatibility.
  const COHERE_TIMEOUT_MS = 90_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Create a fresh AbortController for each attempt
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COHERE_TIMEOUT_MS);

    // If caller provided a signal, listen for it too
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutId);
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
          controller.abort();
        });
      }
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.COHERE_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: options.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Success — clear the timeout
      clearTimeout(timeoutId);

      if (response.ok) return response;

      const errorBody = await response.text();

      if (isMonthlyQuotaError(response.status, errorBody)) {
        clearTimeout(timeoutId);
        throw new CohereError(
          `Cohere monthly call quota exhausted for model "${String(body.model ?? 'unknown')}". ` +
            `This is an account limit on the Cohere key, not a fault in this request — ` +
            `it resets when the billing month rolls over. Raw: ${errorBody}`,
          'COHERE_MONTHLY_QUOTA_EXHAUSTED',
          response.status,
          { endpoint, status: response.status, model: body.model }
        );
      }

      // If this is a retryable error and we haven't exhausted retries,
      // wait with exponential backoff and retry
      const retryable =
        RETRYABLE_STATUS.has(response.status) ||
        isTransientGenerationError(response.status, errorBody);
      if (retryable && attempt < MAX_RETRIES) {
        clearTimeout(timeoutId);
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `Cohere API returned ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
            `Retrying in ${delay}ms... Error: ${errorBody.slice(0, 200)}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        lastError = new CohereError(
          `Cohere API returned ${response.status}: ${errorBody}`,
          `COHERE_HTTP_${response.status}`,
          response.status,
          { endpoint, status: response.status, attempt: attempt + 1 }
        );
        continue;
      }

      // Non-retryable error or retries exhausted — throw
      clearTimeout(timeoutId);
      throw new CohereError(
        `Cohere API returned ${response.status}: ${errorBody}`,
        `COHERE_HTTP_${response.status}`,
        response.status,
        { endpoint, status: response.status, retries: attempt }
      );
    } catch (err) {
      // Network errors (fetch throws) — retry if we haven't exhausted
      if (attempt < MAX_RETRIES && !(err instanceof CohereError)) {
        clearTimeout(timeoutId);
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `Cohere API network error (attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
            `Retrying in ${delay}ms... Error: ${err}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        lastError = new CohereError(
          `Cohere API network error: ${err}`,
          'COHERE_NETWORK_ERROR',
          0,
          { endpoint, attempt: attempt + 1 }
        );
        continue;
      }
      throw err;
    }
  }

  // All retries exhausted
  throw (
    lastError ??
    new CohereError(
      'Cohere API: all retries exhausted',
      'COHERE_RETRIES_EXHAUSTED',
      0,
      { endpoint, retries: MAX_RETRIES }
    )
  );
}

export async function cohereRequestJson<T>(
  endpoint: keyof typeof COHERE_ENDPOINTS,
  body: Record<string, unknown>,
  env: CohereEnv,
  options?: { signal?: AbortSignal }
): Promise<CohereResponse<T>> {
  const response = await cohereRequest(endpoint, body, env, {
    ...options,
    stream: false,
  });
  const data = (await response.json()) as T;
  const requestId = response.headers.get('x-request-id');

  return {
    data,
    requestId,
    cost: null, // Populated by specific endpoints
    warnings: [],
  };
}

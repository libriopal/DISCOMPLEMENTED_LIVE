/**
 * @bicameral/cohere/openrouter — the OpenAI-compatible transport.
 *
 * Two providers reach the wire through here, and they are deliberately the
 * same code path: OpenRouter (North Mini Code for the coder's free-first
 * routing) and, since 2026-08-30, NVIDIA's own `integrate.api.nvidia.com` for
 * the independent auditor. Both speak `POST /chat/completions` in OpenAI's
 * shape, and the response is normalized into the same
 * ChatRequest/ChatResponse pair as Cohere so callers do not need to know
 * which provider served the request.
 *
 * What the caller DOES need to control is the credential, because these are
 * different accounts with different blast radii. That is why the provider is
 * a parameter (`callOpenAICompatible`) rather than a base-URL override on a
 * single hard-coded key: routing the auditor to NVIDIA while still sending
 * `OPENROUTER_API_KEY` in the Authorization header would 401 per chunk, and a
 * per-chunk 401 is recorded by the audit scripts as "unreachable" — an audit
 * that reports itself incomplete for what reads as a network fault.
 */
import { CohereError } from '@bicameral/shared';
import type { ChatRequest, ChatResponse } from './chat.js';
import type { CohereResponse } from './index.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_BASE_URL?: string;
}

/**
 * One OpenAI-compatible endpoint and the credential that opens it.
 *
 * `keyVar` exists so the "not set" error below can name the environment
 * variable an operator has to provision. Without it the message would have to
 * say "the API key", which is the one thing the reader already knows.
 */
export interface OpenAICompatibleProvider {
  /** Human name, used in error text: "OpenRouter", "NVIDIA". */
  label: string;
  /** Origin + version prefix, no trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** The env var that supplies `apiKey`, for the unset-key message. */
  keyVar: string;
  /** Prefix for `CohereError.code`, e.g. `OPENROUTER` -> `OPENROUTER_HTTP_429`. */
  codePrefix: string;
}

interface OpenRouterCompletion {
  id: string;
  choices: {
    message: { role: string; content: string };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Back-compat wrapper: OpenRouter, configured from the Worker's env. */
export async function callOpenRouter(
  request: ChatRequest,
  env: OpenRouterEnv
): Promise<CohereResponse<ChatResponse>> {
  return callOpenAICompatible(request, {
    label: 'OpenRouter',
    baseUrl: env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
    apiKey: env.OPENROUTER_API_KEY,
    keyVar: 'OPENROUTER_API_KEY',
    codePrefix: 'OPENROUTER',
  });
}

export async function callOpenAICompatible(
  request: ChatRequest,
  provider: OpenAICompatibleProvider
): Promise<CohereResponse<ChatResponse>> {
  const base = provider.baseUrl;

  // Checked before the call rather than left to a 401. An unset secret and a
  // revoked key both arrive as "API returned 401" otherwise, and the two have
  // completely different fixes. This matters most for the audit step, where
  // the caller's only correct response to any failure here is to stop the run
  // — so the message has to say which failure it was.
  if (!provider.apiKey) {
    throw new CohereError(
      `${provider.keyVar} is not set, so the ${provider.label} model could ` +
        `not be called. Provision it with \`wrangler secret put ${provider.keyVar}\`.`,
      `${provider.codePrefix}_KEY_MISSING`,
      401,
      { provider: provider.label.toLowerCase(), model: request.model }
    );
  }

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model,
      messages: [
        ...(request.preamble
          ? [{ role: 'system', content: request.preamble }]
          : []),
        // `toolCalls`/`toolCallId` were dropped here, and the drop was
        // one-directional and therefore silent: the response path below
        // already reads `finish_reason === 'tool_calls'`, so a first turn
        // through this transport could ask for a tool and the loop could run
        // it — and then the *second* turn re-sent the history as
        // `{role, content}` only. An OpenAI-compatible endpoint rejects that
        // with `400 invalid_request_error: messages with role "tool" must be
        // a response to a preceding message with tool_calls`, at the turn
        // after the one that caused it. Same defect `chat.ts` was fixed for
        // (see toOutgoingMessage there); this transport never got the fix.
        //
        // Cohere's field names are camelCase, OpenAI's are snake_case, and
        // both keys are omitted rather than sent as undefined — some
        // endpoints validate the *presence* of `tool_call_id` on a non-tool
        // message rather than its value.
        ...request.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCallId && { tool_call_id: m.toolCallId }),
          ...(m.toolCalls?.length && { tool_calls: m.toolCalls }),
        })),
      ],
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.maxTokens && { max_tokens: request.maxTokens }),
      // `responseFormat` was being dropped here. Cohere's field name is
      // camelCase and OpenRouter's is `response_format`, so the request went
      // out with no JSON-mode instruction at all and the caller had no way to
      // tell: the model usually returns JSON anyway when the prompt asks for
      // it, and usually is exactly the failure that shows up in production
      // rather than in a test. The auditor (§4A) depends on this — its output
      // is schema-validated and a prose preamble fails the parse.
      ...(request.responseFormat && {
        response_format: request.responseFormat,
      }),
      ...(request.tools && {
        tools: request.tools.map((t) => ({
          type: 'function',
          function: t.function,
        })),
      }),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new CohereError(
      `${provider.label} API returned ${response.status}: ${errorBody}`,
      `${provider.codePrefix}_HTTP_${response.status}`,
      response.status,
      {
        provider: provider.label.toLowerCase(),
        model: request.model,
        status: response.status,
      }
    );
  }

  const data = (await response.json()) as OpenRouterCompletion;
  const choice = data.choices[0];

  return {
    data: {
      id: data.id,
      message: {
        role: 'assistant',
        content: choice.message.content,
      },
      finishReason:
        choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'complete',
      usage: {
        billedTokens: data.usage.total_tokens,
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    },
    requestId: data.id,
    cost: {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      billedTokens: data.usage.total_tokens,
    },
    warnings: [],
  };
}

/**
 * @bicameral/cohere/openrouter — OpenRouter client for North Mini Code (free tier)
 * Used by the Coder agent (Step 4) as the first rung of free-first model routing.
 * Direct fetch() to OpenRouter's OpenAI-compatible chat completions endpoint —
 * response is normalized into the same ChatRequest/ChatResponse shape as Cohere
 * so callers don't need to know which provider actually served the request.
 */
import { CohereError } from '@bicameral/shared';
import type { ChatRequest, ChatResponse } from './chat.js';
import type { CohereResponse } from './index.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_BASE_URL?: string;
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

export async function callOpenRouter(
  request: ChatRequest,
  env: OpenRouterEnv
): Promise<CohereResponse<ChatResponse>> {
  const base = env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL;

  // Checked before the call rather than left to a 401. An unset secret and a
  // revoked key both arrive as "OpenRouter API returned 401" otherwise, and
  // the two have completely different fixes. This matters most for the audit
  // step, where the caller's only correct response to any failure here is to
  // stop the run — so the message has to say which failure it was.
  if (!env.OPENROUTER_API_KEY) {
    throw new CohereError(
      'OPENROUTER_API_KEY is not set, so the OpenRouter model could not be ' +
        'called. Provision it with `wrangler secret put OPENROUTER_API_KEY`.',
      'OPENROUTER_KEY_MISSING',
      401,
      { provider: 'openrouter', model: request.model }
    );
  }

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model,
      messages: [
        ...(request.preamble
          ? [{ role: 'system', content: request.preamble }]
          : []),
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
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
      `OpenRouter API returned ${response.status}: ${errorBody}`,
      `OPENROUTER_HTTP_${response.status}`,
      response.status,
      { provider: 'openrouter', model: request.model, status: response.status }
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

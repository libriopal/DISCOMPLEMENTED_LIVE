/**
 * @bicameral/cohere/chat — Chat completions with tool use support
 */
import {
  cohereRequestJson,
  type CohereEnv,
  type CohereResponse,
} from './index.js';
import { CohereError } from '@bicameral/shared';
import { quotaFallbackModel, REASONING_MODELS } from './model-router.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Assistant-only, required by v2 on a message that carries `toolCalls`:
   * the model's stated reason for calling them. Defaults to the message's
   * thinking or content when omitted. */
  toolPlan?: string;
  /** Tool-only. Structured tool results, sent as v2 `document` content
   * blocks. A tool message carrying these is what makes the model emit
   * citations pointing back at the source; a plain JSON string in `content`
   * is accepted by the API but produces none — measured 2026-08-25, see
   * toolResultContent() and chatWithToolLoop(). */
  documents?: ToolResultDocument[];
  /** Assistant-only. Cohere's own model card for North Mini Code says
   * thinking/reasoning content should be "retained and passed along in the
   * conversation history" on later turns for best agentic performance —
   * https://huggingface.co/CohereLabs/North-Mini-Code-1.0 (verified
   * 2026-08-12). When present on an outgoing assistant message, chat()
   * sends content as [{type:'thinking',...}, {type:'text',...}] instead of
   * a flat string, per docs.cohere.com/reference/chat's request schema. */
  thinking?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * One tool result, in the shape v2 needs for citations.
 *
 * `id` is what comes back as `citation.sources[].id`, so set it to something
 * you can resolve — a URL is ideal. Omitting it makes Cohere generate
 * `<tool_call_id>:<n>`, which cites nothing you can link to.
 */
export interface ToolResultDocument {
  id?: string;
  data: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  preamble?: string;
  /**
   * v2 citation mode. Sent as `citation_options: { mode }`.
   *
   * This was `citationQuality`, sent as a top-level `citation_quality` field
   * — the **v1** parameter name. v2 does not merely ignore it, it rejects
   * the whole request with HTTP 422 `unknown field: parameter
   * 'citation_quality' is not a valid field`, so every call that set the
   * option failed outright (measured 2026-08-25).
   *
   * `'accurate'` is the documented default but **400s on both models this
   * repo dispatches** — `command-a-reasoning-08-2025` and `command-a-03-2025`
   * each answer `This model does not support the provided citation mode`.
   * Only `'fast'` is usable here; the union keeps `'accurate'` so the day a
   * model supports it this is a one-word change, not a type change.
   */
  citationMode?: 'fast' | 'accurate';
  responseFormat?: { type: 'json_object' | 'text' };
  /** Reasoning is enabled by default on reasoning-capable models
   * (docs.cohere.com/docs/reasoning, verified 2026-08-12) — this only needs
   * setting to disable it or cap `tokenBudget`. */
  thinking?: { type?: 'enabled' | 'disabled'; tokenBudget?: number };
}

export interface ChatResponse {
  id: string;
  message: ChatMessage;
  finishReason: 'complete' | 'tool_calls' | 'max_tokens' | 'error';
  toolCalls?: ToolCall[];
  citations?: Citation[];
  usage: {
    billedTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * A grounded span in the answer, mapped back to the tool results it came from.
 *
 * `documentIds: string[]` was the v1 shape and never matched anything v2
 * returns; v2 sends `sources: [{ type, id, tool_output }]`. Nothing parsed it
 * off the response either — `ChatResponse.citations` was declared and left
 * permanently `undefined`. Both fixed 2026-08-25 against a live capture.
 */
export interface Citation {
  start: number;
  end: number;
  text: string;
  sources: CitationSource[];
}

export interface CitationSource {
  /** `'tool'` for a tool result; `'document'` for a directly-supplied doc. */
  type: string;
  /** The `id` given in the tool result document — a URL, if one was set. */
  id: string;
  toolOutput?: Record<string, unknown>;
}

// Cohere's actual v2 /chat response — snake_case, and `message.content` is
// an array of content blocks (not a plain string like our ChatMessage).
// Verified directly against the live API: `content` is
// `[{ type: "text", text: "..." }]`, `finish_reason` is upper-cased
// (COMPLETE/TOOL_CALLS/...), and usage is nested under `tokens`/
// `billed_units` — none of which lines up with ChatResponse below without
// this mapping. See mapChatResponse().
interface CohereRawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface CohereRawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CohereRawCitation {
  start?: number;
  end?: number;
  text?: string;
  sources?: Array<{
    type?: string;
    id?: string;
    tool_output?: Record<string, unknown>;
  }>;
}

interface CohereRawChatResponse {
  id: string;
  message: {
    role: string;
    content?: CohereRawContentBlock[] | string;
    tool_calls?: CohereRawToolCall[];
    citations?: CohereRawCitation[];
  };
  finish_reason: string;
  usage?: {
    billed_units?: { input_tokens?: number; output_tokens?: number };
    tokens?: { input_tokens?: number; output_tokens?: number };
  };
}

const FINISH_REASON_MAP: Record<string, ChatResponse['finishReason']> = {
  COMPLETE: 'complete',
  // v2 sends the SINGULAR `TOOL_CALL` — captured live 2026-08-25. Only
  // `TOOL_CALLS` was mapped, so every tool-calling response fell through the
  // `?? 'complete'` default below and `chatWithToolLoop` returned on its
  // first pass with the tool calls never executed. Both spellings are mapped
  // now; do not remove either.
  TOOL_CALL: 'tool_calls',
  TOOL_CALLS: 'tool_calls',
  MAX_TOKENS: 'max_tokens',
  ERROR: 'error',
};

function extractText(
  content: CohereRawContentBlock[] | string | undefined
): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter(
      (block): block is CohereRawContentBlock & { text: string } =>
        block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('');
}

// Thinking arrives as its own `type: "thinking"` content block, separate
// from `type: "text"` — confirmed against docs.cohere.com/reference/chat's
// response schema (2026-08-12), so extractText() above was never at risk of
// mixing reasoning prose into a JSON-parsed answer. This just surfaces it
// for callers that want to inspect or forward it (see ChatMessage.thinking).
function extractThinking(
  content: CohereRawContentBlock[] | string | undefined
): string | undefined {
  if (typeof content === 'string' || !content) return undefined;
  const thinking = content
    .filter(
      (block): block is CohereRawContentBlock & { thinking: string } =>
        block.type === 'thinking' && typeof block.thinking === 'string'
    )
    .map((block) => block.thinking)
    .join('');
  return thinking || undefined;
}

// Citations arrive on `message.citations`, not at the top level, and are
// best-effort: identical requests returned 8, 7, 4 and — twice — none at all
// (measured 2026-08-25). Treat an empty array as "this answer is ungrounded",
// never as "the request was wrong".
function extractCitations(
  raw: CohereRawCitation[] | undefined
): Citation[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map((c) => ({
    start: c.start ?? 0,
    end: c.end ?? 0,
    text: c.text ?? '',
    sources: (c.sources ?? []).map((s) => ({
      type: s.type ?? 'tool',
      id: s.id ?? '',
      ...(s.tool_output && { toolOutput: s.tool_output }),
    })),
  }));
}

function mapChatResponse(raw: CohereRawChatResponse): ChatResponse {
  const billedInput = raw.usage?.billed_units?.input_tokens ?? 0;
  const billedOutput = raw.usage?.billed_units?.output_tokens ?? 0;

  return {
    id: raw.id,
    message: {
      role: (raw.message.role as ChatMessage['role']) || 'assistant',
      content: extractText(raw.message.content),
      toolCalls: raw.message.tool_calls,
      thinking: extractThinking(raw.message.content),
    },
    finishReason: FINISH_REASON_MAP[raw.finish_reason] ?? 'complete',
    toolCalls: raw.message.tool_calls,
    citations: extractCitations(raw.message.citations),
    usage: {
      inputTokens: raw.usage?.tokens?.input_tokens ?? billedInput,
      outputTokens: raw.usage?.tokens?.output_tokens ?? billedOutput,
      billedTokens: billedInput + billedOutput,
    },
  };
}

/** v2 tool-result content blocks — the shape citations are derived from. */
function toolResultContent(documents: ToolResultDocument[]) {
  return documents.map((d) => ({
    type: 'document',
    document: { ...(d.id && { id: d.id }), data: d.data },
  }));
}

/**
 * Map one outgoing message to the v2 wire shape.
 *
 * This used to emit `{ role, content }` and nothing else, silently dropping
 * `toolCalls` and `toolCallId`. The effect was that `chatWithToolLoop` could
 * never survive its second iteration: the assistant turn lost its tool call,
 * the tool turn lost its id, and the API rejected the request outright with
 * `400 invalid tool message at messages[N]: tool_call_id is a required
 * field` (measured 2026-08-25). The loop had no coverage against a real
 * response, so nothing caught it.
 */
function mapOutgoingMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId,
      content: m.documents ? toolResultContent(m.documents) : m.content,
    };
  }

  if (m.role === 'assistant' && m.toolCalls?.length) {
    // v2 wants the intent on `tool_plan`; `content` is not carried on a
    // tool-calling assistant turn.
    return {
      role: 'assistant',
      tool_plan: m.toolPlan || m.thinking || m.content || 'Calling tools.',
      tool_calls: m.toolCalls,
    };
  }

  // Forwarding a prior assistant turn's thinking needs the block-array
  // content shape ([{type:'thinking',...},{type:'text',...}]) per
  // docs.cohere.com/reference/chat's request schema — a flat string has no
  // way to carry it. Every other message keeps the plain string shape.
  return {
    role: m.role,
    content:
      m.role === 'assistant' && m.thinking
        ? [
            { type: 'thinking', thinking: m.thinking },
            { type: 'text', text: m.content },
          ]
        : m.content,
  };
}

/**
 * Retries a request on the uncapped model after Cohere's monthly call quota
 * kills it, or rethrows when there is nothing to fall back to.
 *
 * Cohere caps `command-a-plus-05-2026` and `command-a-reasoning-08-2025` at
 * 1,000 calls a month even on a production key (docs.cohere.com/docs/rate-limits,
 * 2026-08-27). Enterprise runs dispatch to Command A+, so without this an
 * enterprise account is the *first* to stop working — measured 2026-08-25,
 * a run died at step 1 with `429 "You are past the per-month request limit"`.
 *
 * `thinking` is stripped on the way down: the fallback model does not accept
 * the parameter and answers a request carrying it with a 422, which would turn
 * a recoverable quota error into an unrecoverable one.
 */
async function retryOnQuotaExhaustion(
  err: unknown,
  body: Record<string, unknown>,
  env: CohereEnv
): Promise<CohereResponse<CohereRawChatResponse>> {
  const isQuota =
    err instanceof CohereError && err.code === 'COHERE_MONTHLY_QUOTA_EXHAUSTED';
  const fallback = isQuota ? quotaFallbackModel(String(body.model)) : null;
  if (!fallback) throw err;

  console.warn(
    `Cohere monthly quota exhausted for "${String(body.model)}"; ` +
      `falling back to "${fallback}" for this request.`
  );

  const fallbackBody: Record<string, unknown> = { ...body, model: fallback };
  delete fallbackBody.thinking;
  return cohereRequestJson<CohereRawChatResponse>('chat', fallbackBody, env);
}

export async function chat(
  request: ChatRequest,
  env: CohereEnv
): Promise<CohereResponse<ChatResponse>> {
  const body = {
    model: request.model,
    messages: request.messages.map(mapOutgoingMessage),
    ...(request.tools && { tools: request.tools }),
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.topP !== undefined && { p: request.topP }),
    ...(request.maxTokens && { max_tokens: request.maxTokens }),
    ...(request.preamble && { preamble: request.preamble }),
    ...(request.citationMode && {
      citation_options: { mode: request.citationMode },
    }),
    ...(request.responseFormat?.type === 'json_object' && {
      response_format: { type: 'json_object' },
    }),
    // Last line of defence: only models in REASONING_MODELS accept `thinking`
    // at all, and everything else answers a request carrying it with a 422.
    // Callers are supposed to have asked getThinkingConfig() with the model
    // they are dispatching to, but this endpoint is reachable directly (the
    // consciousness compressor calls chat() with north-mini-code-1-0), so the
    // field is dropped here rather than trusted.
    ...(request.thinking &&
      REASONING_MODELS.has(request.model) && {
        // Cohere's wire format uses snake_case `token_budget`, not our
        // internal camelCase `tokenBudget` — verified against
        // docs.cohere.com/docs/reasoning (2026-08-25). Sending the object
        // through unconverted causes a 422 "unknown field: parameter
        // 'tokenBudget' is not a valid field".
        thinking: {
          ...(request.thinking.type && { type: request.thinking.type }),
          ...(request.thinking.tokenBudget !== undefined && {
            token_budget: request.thinking.tokenBudget,
          }),
        },
      }),
  };

  const response = await cohereRequestJson<CohereRawChatResponse>(
    'chat',
    body,
    env
  ).catch((err) => retryOnQuotaExhaustion(err, body, env));

  const data = mapChatResponse(response.data);
  return {
    ...response,
    data,
    cost: {
      inputTokens: data.usage.inputTokens,
      outputTokens: data.usage.outputTokens,
      billedTokens: data.usage.billedTokens,
    },
  };
}

// ============ TOOL USE LOOP ============

/**
 * Normalise whatever a tool returned into citable document blocks.
 *
 * A tool that wants its citations to carry resolvable ids (a URL, a DOI)
 * returns `ToolResultDocument[]` and controls them. Anything else is wrapped
 * in a single document so it is still citable, with Cohere generating
 * `<tool_call_id>:<n>` as the id.
 *
 * The loop used to push `JSON.stringify(result)` as a plain string. The API
 * accepts that, which is why it went unnoticed — but a string tool result
 * yields no citations at all, so every grounded answer the pipeline produced
 * was unattributable.
 */
function asToolDocuments(result: unknown): ToolResultDocument[] {
  if (
    Array.isArray(result) &&
    result.length > 0 &&
    result.every(
      (d): d is ToolResultDocument =>
        typeof d === 'object' &&
        d !== null &&
        'data' in d &&
        typeof (d as ToolResultDocument).data === 'object'
    )
  ) {
    return result;
  }
  return [{ data: { result: JSON.stringify(result) } }];
}

export async function chatWithToolLoop(
  request: ChatRequest,
  tools: Map<string, (args: unknown) => Promise<unknown>>,
  env: CohereEnv,
  maxIterations = 10
): Promise<CohereResponse<ChatResponse>> {
  const messages = [...request.messages];
  let lastResponse: CohereResponse<ChatResponse> | null = null;

  for (let i = 0; i < maxIterations; i++) {
    lastResponse = await chat({ ...request, messages }, env);

    // Keyed on the presence of tool calls, not on the finish reason. A
    // finish reason this client does not recognise defaults to 'complete',
    // which is exactly how the `TOOL_CALL`/`TOOL_CALLS` mismatch above went
    // unnoticed — if the model asked for a tool, run it whatever the label.
    if (!lastResponse.data.toolCalls?.length) {
      return lastResponse;
    }

    // Execute tool calls
    messages.push({
      role: 'assistant',
      content: lastResponse.data.message.content,
      thinking: lastResponse.data.message.thinking,
      toolCalls: lastResponse.data.toolCalls,
    });

    for (const toolCall of lastResponse.data.toolCalls) {
      const toolFn = tools.get(toolCall.function.name);
      if (!toolFn) {
        messages.push({
          role: 'tool',
          content: `Error: Unknown tool "${toolCall.function.name}"`,
          toolCallId: toolCall.id,
        });
        continue;
      }

      try {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await toolFn(args);
        messages.push({
          role: 'tool',
          // Kept for callers that read message history back as text; the
          // wire format comes from `documents`.
          content: JSON.stringify(result),
          documents: asToolDocuments(result),
          toolCallId: toolCall.id,
        });
      } catch (err) {
        messages.push({
          role: 'tool',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          toolCallId: toolCall.id,
        });
      }
    }
  }

  if (!lastResponse) {
    throw new CohereError(
      'Tool loop ended without response',
      'TOOL_LOOP_EMPTY',
      500
    );
  }
  return lastResponse;
}

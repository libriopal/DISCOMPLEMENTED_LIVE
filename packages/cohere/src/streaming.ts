/**
 * @bicameral/cohere/streaming — SSE streaming for chat responses
 * Server-Sent Events format for real-time generation output
 */
import { cohereRequest, type CohereEnv } from './index.js';
import type { ChatRequest } from './chat.js';

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'citation' | 'finish' | 'error';
  content?: string;
  toolCall?: { id: string; name: string; arguments: string };
  citation?: {
    start: number;
    end: number;
    text: string;
    documentIds: string[];
  };
  finishReason?: string;
  error?: string;
}

/**
 * The subset of Cohere v2's streamed event shapes this parser reads.
 *
 * These are Cohere's shapes, and getting them wrong is silent: this file used
 * to match Anthropic's schema — `content_block_delta` with text at
 * `delta.text`, and `message_stop` — but v2 emits *hyphenated* event names and
 * nests text at `delta.message.content.text`. Every event fell through the
 * chain, so the generator yielded nothing at all and `/api/generate` streamed
 * its opening "plan" line and then silence, while the run was still recorded
 * `completed` and billed. Measured against production on 2026-08-26: the
 * request returned HTTP 200 (`cohereRequest` throws on anything else, so a
 * quota or auth failure could not have produced this) and zero chunks came
 * back. See CLAUDE.md — v2 wire shapes have bitten this repo repeatedly.
 */
interface CohereStreamEvent {
  type?: string;
  index?: number;
  delta?: {
    finish_reason?: string;
    message?: {
      content?: { text?: string };
      tool_plan?: string;
      tool_calls?: {
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      citations?: {
        start?: number;
        end?: number;
        text?: string;
        sources?: { id?: string; document?: { id?: string } }[];
      };
    };
  };
}

export async function* streamChat(
  request: ChatRequest,
  env: CohereEnv
): AsyncGenerator<StreamChunk> {
  const body = {
    model: request.model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    stream: true,
    ...(request.tools && { tools: request.tools }),
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.maxTokens && { max_tokens: request.maxTokens }),
    ...(request.preamble && { preamble: request.preamble }),
  };

  const response = await cohereRequest('chat', body, env, { stream: true });

  if (!response.body) {
    throw new Error('No response body for streaming');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Keyed by the event's content index — Cohere can interleave more than one
  // tool call in a single message.
  const pendingToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        let parsed: CohereStreamEvent;
        try {
          parsed = JSON.parse(data) as CohereStreamEvent;
        } catch {
          // Skip malformed JSON
          continue;
        }

        const message = parsed.delta?.message;

        switch (parsed.type) {
          case 'content-delta': {
            const text = message?.content?.text;
            if (text) yield { type: 'text', content: text };
            break;
          }

          // Tool calls arrive as a start event naming the function, then a run
          // of deltas each carrying a fragment of the JSON arguments. Only the
          // accumulated whole is useful to a caller, so it is emitted at -end.
          case 'tool-call-start': {
            const call = message?.tool_calls;
            if (call) {
              pendingToolCalls.set(parsed.index ?? 0, {
                id: call.id ?? '',
                name: call.function?.name ?? '',
                arguments: call.function?.arguments ?? '',
              });
            }
            break;
          }
          case 'tool-call-delta': {
            const pending = pendingToolCalls.get(parsed.index ?? 0);
            const fragment = message?.tool_calls?.function?.arguments;
            if (pending && fragment) pending.arguments += fragment;
            break;
          }
          case 'tool-call-end': {
            const index = parsed.index ?? 0;
            const pending = pendingToolCalls.get(index);
            if (pending) {
              pendingToolCalls.delete(index);
              yield {
                type: 'tool_call',
                toolCall: { ...pending, arguments: pending.arguments || '{}' },
              };
            }
            break;
          }

          case 'citation-start': {
            const citation = message?.citations;
            if (citation) {
              yield {
                type: 'citation',
                citation: {
                  start: citation.start ?? 0,
                  end: citation.end ?? 0,
                  text: citation.text ?? '',
                  // v2 renamed document_ids to sources[]; each source carries
                  // the document id the citation resolves to.
                  documentIds: (citation.sources ?? [])
                    .map((s) => s.id ?? s.document?.id ?? '')
                    .filter(Boolean),
                },
              };
            }
            break;
          }

          case 'message-end': {
            yield {
              type: 'finish',
              finishReason: parsed.delta?.finish_reason ?? 'complete',
            };
            break;
          }

          default:
            // message-start, content-start, content-end, citation-end,
            // tool-plan-delta — no caller-visible payload.
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============ SSE HELPER FOR HONO ============
export function streamToSSE(
  stream: AsyncGenerator<StreamChunk>
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const data = JSON.stringify(chunk);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        const errorData = JSON.stringify({
          type: 'error',
          error: err instanceof Error ? err.message : 'Stream error',
        });
        controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

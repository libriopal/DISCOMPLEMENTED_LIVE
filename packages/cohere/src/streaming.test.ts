/**
 * This parser was written against Anthropic's SSE schema — `content_block_delta`
 * with text at `delta.text`, terminated by `message_stop`. Cohere v2 emits
 * *hyphenated* event names and nests text one level deeper, at
 * `delta.message.content.text`. Nothing matched, so `streamChat` yielded
 * nothing at all, and because a zero-chunk stream is indistinguishable from a
 * short one, `/api/generate` recorded every run as `completed` while billing
 * for it (measured in production 2026-08-26: `tokens_out = 0`,
 * `credits_used = 10`, `status = 'completed'`).
 *
 * These tests feed literal Cohere-shaped SSE bytes, copied from the event
 * shapes documented at docs.cohere.com/docs/streaming, rather than fixtures
 * massaged to already match `StreamChunk`. A future rewrite that guesses at the
 * schema again fails here instead of in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CohereEnv } from './index.js';
import type { StreamChunk } from './streaming.js';

const env: CohereEnv = { COHERE_API_KEY: 'test-key' };

/** Serves `events` as an SSE body, optionally split across arbitrary network
 * chunk boundaries so the line-buffering path is exercised too. */
function mockStream(events: unknown[], { splitEvery = 0 } = {}) {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(payload);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const size = splitEvery > 0 ? splitEvery : bytes.length;
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    },
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200 }))
  );
}

async function collect(): Promise<StreamChunk[]> {
  const { streamChat } = await import('./streaming.js');
  const chunks: StreamChunk[] = [];
  for await (const chunk of streamChat(
    { model: 'command-a-03-2025', messages: [{ role: 'user', content: 'hi' }] },
    env
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('streamChat() — Cohere v2 event shapes', () => {
  it('yields text from content-delta and finishes on message-end', async () => {
    mockStream([
      { type: 'message-start', id: 'x' },
      { type: 'content-start', index: 0 },
      {
        type: 'content-delta',
        index: 0,
        delta: { message: { content: { text: 'Hello' } } },
      },
      {
        type: 'content-delta',
        index: 0,
        delta: { message: { content: { text: ' world' } } },
      },
      { type: 'content-end', index: 0 },
      { type: 'message-end', delta: { finish_reason: 'COMPLETE' } },
    ]);

    const chunks = await collect();

    expect(
      chunks.filter((c) => c.type === 'text').map((c) => c.content)
    ).toEqual(['Hello', ' world']);
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'COMPLETE' });
  });

  it('does not match Anthropic-shaped events', async () => {
    // The exact schema this file used to be written against. It must now
    // produce nothing, so a regression cannot hide behind a passing stream.
    mockStream([
      { type: 'content_block_delta', delta: { text: 'Hello' } },
      { type: 'message_stop' },
    ]);

    expect(await collect()).toEqual([]);
  });

  it('reassembles a tool call fragmented across deltas', async () => {
    mockStream([
      {
        type: 'tool-call-start',
        index: 0,
        delta: {
          message: {
            tool_calls: {
              id: 'call-1',
              function: { name: 'get_weather', arguments: '' },
            },
          },
        },
      },
      {
        type: 'tool-call-delta',
        index: 0,
        delta: {
          message: { tool_calls: { function: { arguments: '{"city"' } } },
        },
      },
      {
        type: 'tool-call-delta',
        index: 0,
        delta: {
          message: { tool_calls: { function: { arguments: ': "Reno"}' } } },
        },
      },
      { type: 'tool-call-end', index: 0 },
    ]);

    const calls = (await collect()).filter((c) => c.type === 'tool_call');
    expect(calls).toEqual([
      {
        type: 'tool_call',
        toolCall: {
          id: 'call-1',
          name: 'get_weather',
          arguments: '{"city": "Reno"}',
        },
      },
    ]);
  });

  it('maps v2 citation sources[] onto documentIds', async () => {
    // v1 sent `document_ids`; v2 replaced it with `sources[]`. Reading the old
    // name yields citations that point at nothing.
    mockStream([
      {
        type: 'citation-start',
        index: 0,
        delta: {
          message: {
            citations: {
              start: 6,
              end: 11,
              text: 'world',
              sources: [
                { id: 'https://example.com/a' },
                { document: { id: 'doc-b' } },
              ],
            },
          },
        },
      },
    ]);

    expect((await collect())[0]).toEqual({
      type: 'citation',
      citation: {
        start: 6,
        end: 11,
        text: 'world',
        documentIds: ['https://example.com/a', 'doc-b'],
      },
    });
  });

  it('survives events split across network chunk boundaries', async () => {
    mockStream(
      [
        {
          type: 'content-delta',
          index: 0,
          delta: { message: { content: { text: 'abc' } } },
        },
        { type: 'message-end', delta: { finish_reason: 'COMPLETE' } },
      ],
      { splitEvery: 7 }
    );

    const chunks = await collect();
    expect(
      chunks.filter((c) => c.type === 'text').map((c) => c.content)
    ).toEqual(['abc']);
    expect(chunks.at(-1)?.type).toBe('finish');
  });
});

/**
 * Real Cohere v2 /chat responses are snake_case with content as an array of
 * blocks (`[{ type: "text", text: "..." }]`) and usage nested under
 * `tokens`/`billed_units` — every one of tonight's real chat.ts bugs was a
 * mismatch between that shape and ChatResponse. These tests exercise
 * mapChatResponse() (via the public chat()) against literal Cohere-shaped
 * JSON, not fixtures massaged to already match our types.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CohereEnv } from './index.js';

const env: CohereEnv = { COHERE_API_KEY: 'test-key' };

function mockFetchOnce(body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  // Returned so a test can assert on the *request* body, not just the
  // response mapping — the v1/v2 field-name bugs were all outbound.
  return fetchMock as unknown as {
    mock: { calls: Array<[string, { body: string }]> };
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('chat() response mapping', () => {
  it('extracts text from the real array-of-blocks content shape', async () => {
    const { chat } = await import('./chat.js');
    mockFetchOnce({
      id: 'resp-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello, ' },
          { type: 'text', text: 'world.' },
        ],
      },
      finish_reason: 'COMPLETE',
      usage: {
        billed_units: { input_tokens: 12, output_tokens: 8 },
        tokens: { input_tokens: 15, output_tokens: 10 },
      },
    });

    const result = await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'hi' }],
      },
      env
    );

    expect(result.data.message.content).toBe('Hello, world.');
    expect(result.data.finishReason).toBe('complete');
    expect(result.data.usage).toEqual({
      inputTokens: 15,
      outputTokens: 10,
      billedTokens: 20,
    });
  });

  it('falls back to billed_units when the tokens block is absent', async () => {
    const { chat } = await import('./chat.js');
    mockFetchOnce({
      id: 'resp-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      finish_reason: 'COMPLETE',
      usage: { billed_units: { input_tokens: 5, output_tokens: 3 } },
    });

    const result = await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'hi' }],
      },
      env
    );

    expect(result.data.usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      billedTokens: 8,
    });
  });

  it('maps every documented finish_reason, defaulting unknown values to complete', async () => {
    const { chat } = await import('./chat.js');
    const cases: [string, string][] = [
      ['COMPLETE', 'complete'],
      // v2 sends the singular form. Captured live 2026-08-25; mapping only
      // the plural silently degraded every tool call to 'complete'.
      ['TOOL_CALL', 'tool_calls'],
      ['TOOL_CALLS', 'tool_calls'],
      ['MAX_TOKENS', 'max_tokens'],
      ['ERROR', 'error'],
      ['SOMETHING_UNDOCUMENTED', 'complete'],
    ];

    for (const [raw, expected] of cases) {
      mockFetchOnce({
        id: 'resp',
        message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
        finish_reason: raw,
        usage: {},
      });
      const result = await chat(
        {
          model: 'command-a-03-2025',
          messages: [{ role: 'user', content: 'hi' }],
        },
        env
      );
      expect(result.data.finishReason).toBe(expected);
    }
  });

  it('carries tool_calls through onto both message and top-level toolCalls', async () => {
    const { chat } = await import('./chat.js');
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ];
    mockFetchOnce({
      id: 'resp-3',
      message: { role: 'assistant', tool_calls: toolCalls },
      finish_reason: 'TOOL_CALLS',
      usage: {},
    });

    const result = await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'hi' }],
      },
      env
    );

    expect(result.data.toolCalls).toEqual(toolCalls);
    expect(result.data.message.toolCalls).toEqual(toolCalls);
    expect(result.data.message.content).toBe('');
  });

  it('handles a plain-string content body (not just the block-array shape)', async () => {
    const { chat } = await import('./chat.js');
    mockFetchOnce({
      id: 'resp-4',
      message: { role: 'assistant', content: 'plain string' },
      finish_reason: 'COMPLETE',
      usage: {},
    });

    const result = await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'hi' }],
      },
      env
    );

    expect(result.data.message.content).toBe('plain string');
  });

  // ---- v2 wire-shape regressions, all measured against the live API on
  // 2026-08-25. Each of these shipped broken because nothing here was
  // asserted against a real response body.

  it('sends citation_options, never the v1 citation_quality field', async () => {
    const { chat } = await import('./chat.js');
    const fetchMock = mockFetchOnce({
      id: 'r',
      message: { role: 'assistant', content: 'x' },
      finish_reason: 'COMPLETE',
      usage: {},
    });

    await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'hi' }],
        citationMode: 'fast',
      },
      env
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.citation_options).toEqual({ mode: 'fast' });
    // The v1 name is rejected by v2 with HTTP 422 `unknown field`, failing
    // the whole request — not ignored.
    expect(body).not.toHaveProperty('citation_quality');
  });

  it('parses citations off message.citations into the v2 sources shape', async () => {
    const { chat } = await import('./chat.js');
    mockFetchOnce({
      id: 'r',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Verified by recomputing hashes.' }],
        citations: [
          {
            start: 13,
            end: 31,
            text: 'recomputing hashes',
            sources: [
              {
                type: 'tool',
                id: 'https://example.org/merkle',
                tool_output: { text: 'bottom-up recomputation' },
              },
            ],
          },
        ],
      },
      finish_reason: 'COMPLETE',
      usage: {},
    });

    const result = await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'q' }],
      },
      env
    );

    // Previously declared on the type and never populated.
    expect(result.data.citations).toHaveLength(1);
    expect(result.data.citations?.[0]).toMatchObject({
      start: 13,
      end: 31,
      text: 'recomputing hashes',
      sources: [{ type: 'tool', id: 'https://example.org/merkle' }],
    });
  });

  it('leaves citations undefined when the model grounded nothing', async () => {
    const { chat } = await import('./chat.js');
    mockFetchOnce({
      id: 'r',
      message: { role: 'assistant', content: 'ungrounded' },
      finish_reason: 'COMPLETE',
      usage: {},
    });
    const result = await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'q' }],
      },
      env
    );
    // Identical requests returned 8, 7, 4 and zero citations against the
    // live API. Absence means ungrounded, not malformed.
    expect(result.data.citations).toBeUndefined();
  });

  it('preserves tool_call_id and tool_calls on outgoing messages', async () => {
    const { chat } = await import('./chat.js');
    const fetchMock = mockFetchOnce({
      id: 'r',
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'COMPLETE',
      usage: {},
    });

    await chat(
      {
        model: 'command-a-03-2025',
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'f', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' },
        ],
      },
      env
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Dropping these produced `400 invalid tool message at messages[N]:
    // tool_call_id is a required field`, so the tool loop could never
    // survive a second iteration.
    expect(body.messages[1].tool_calls).toHaveLength(1);
    expect(body.messages[1].tool_plan).toBeTruthy();
    expect(body.messages[2].tool_call_id).toBe('call_1');
  });

  it('sends tool results as document blocks when documents are supplied', async () => {
    const { chat } = await import('./chat.js');
    const fetchMock = mockFetchOnce({
      id: 'r',
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'COMPLETE',
      usage: {},
    });

    await chat(
      {
        model: 'command-a-03-2025',
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'tool',
            content: 'ignored',
            toolCallId: 'call_1',
            documents: [
              { id: 'https://example.org/a', data: { text: 'hello' } },
            ],
          },
        ],
      },
      env
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // A plain string here is accepted but yields no citations at all.
    expect(body.messages[1].content).toEqual([
      {
        type: 'document',
        document: { id: 'https://example.org/a', data: { text: 'hello' } },
      },
    ]);
  });
});

describe('chat() request body', () => {
  it('sends `thinking.tokenBudget` to Cohere as snake_case `token_budget`', async () => {
    // Regression test for a live bug: Cohere's v2 /chat rejected requests
    // with `{"thinking":{"type":"enabled","tokenBudget":1000}}` with a 422
    // "unknown field: parameter 'tokenBudget' is not a valid field" —
    // every other field is converted to Cohere's snake_case wire format
    // except this one was passed straight through un-converted.
    const { chat } = await import('./chat.js');

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp-thinking',
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'COMPLETE',
            usage: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await chat(
      {
        model: 'command-a-reasoning-08-2025',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', tokenBudget: 1000 },
      },
      env
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.thinking).toEqual({ type: 'enabled', token_budget: 1000 });
    expect(sentBody.thinking.tokenBudget).toBeUndefined();
  });

  it('drops `thinking` entirely for a model that cannot accept it', async () => {
    // command-a-03-2025 is the workhorse for every non-enterprise dispatch
    // and answers a request carrying `thinking` with a 422 — even
    // `{type:'disabled'}`. Callers that hardcode it (the consciousness
    // compressor) must not be able to break the request.
    const { chat } = await import('./chat.js');
    const fetchMock = mockFetchOnce({
      id: 'resp-nothink',
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'COMPLETE',
      usage: {},
    });

    await chat(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'disabled' },
      },
      env
    );

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.thinking).toBeUndefined();
  });
});

describe('chat() monthly-quota fallback', () => {
  it('retries an exhausted capped model on the uncapped one, without `thinking`', async () => {
    // The enterprise fallback. Command A+ is capped at 1,000 calls a month
    // even on a production key, so an enterprise run is the first to stop
    // working; a completed run on Command A is worth more to the account
    // holder than a run that dies at step 1.
    const { chat } = await import('./chat.js');

    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(
          JSON.stringify({
            message:
              'You are past the per-month request limit for this model, please wait and try again later.',
          }),
          { status: 429 }
        );
      }
      return new Response(
        JSON.stringify({
          id: 'resp-fallback',
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'COMPLETE',
          usage: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat(
      {
        model: 'command-a-plus-05-2026',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', tokenBudget: 2000 },
      },
      env
    );

    expect(result.data.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const first = JSON.parse(calls[0][1].body as string);
    const second = JSON.parse(calls[1][1].body as string);
    expect(first.model).toBe('command-a-plus-05-2026');
    expect(first.thinking).toEqual({ type: 'enabled', token_budget: 2000 });
    // The fallback model would 422 on `thinking`, turning a recoverable quota
    // error into an unrecoverable one.
    expect(second.model).toBe('command-a-03-2025');
    expect(second.thinking).toBeUndefined();
  });

  it('rethrows a monthly-quota 429 raised by an already-uncapped model', async () => {
    const { chat } = await import('./chat.js');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message:
              'You are past the per-month request limit for this model, please wait and try again later.',
          }),
          { status: 429 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat(
        {
          model: 'command-a-03-2025',
          messages: [{ role: 'user', content: 'hi' }],
        },
        env
      )
    ).rejects.toMatchObject({ code: 'COHERE_MONTHLY_QUOTA_EXHAUSTED' });

    // No second model to try, so exactly one call — no retry loop either.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('chatWithToolLoop()', () => {
  it('executes a tool call and feeds the result back as a tool message', async () => {
    const { chatWithToolLoop } = await import('./chat.js');

    const responses = [
      {
        id: 'r1',
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'add', arguments: '{"a":1,"b":2}' },
            },
          ],
        },
        finish_reason: 'TOOL_CALLS',
        usage: {},
      },
      {
        id: 'r2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The sum is 3.' }],
        },
        finish_reason: 'COMPLETE',
        usage: {},
      },
    ];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(responses[call++]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const add = vi.fn(async (args: unknown) => {
      const { a, b } = args as { a: number; b: number };
      return { sum: a + b };
    });

    const result = await chatWithToolLoop(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'add 1 and 2' }],
      },
      new Map([['add', add]]),
      env
    );

    expect(add).toHaveBeenCalledWith({ a: 1, b: 2 });
    expect(result.data.message.content).toBe('The sum is 3.');
    expect(result.data.finishReason).toBe('complete');
  });

  it('reports unknown tool names back to the model instead of throwing', async () => {
    const { chatWithToolLoop } = await import('./chat.js');

    const responses = [
      {
        id: 'r1',
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'nonexistent_tool', arguments: '{}' },
            },
          ],
        },
        finish_reason: 'TOOL_CALLS',
        usage: {},
      },
      {
        id: 'r2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
        finish_reason: 'COMPLETE',
        usage: {},
      },
    ];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(responses[call++]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const result = await chatWithToolLoop(
      {
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'hi' }],
      },
      new Map(),
      env
    );

    expect(result.data.message.content).toBe('done');
  });
});

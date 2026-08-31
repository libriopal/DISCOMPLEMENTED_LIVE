import { describe, it, expect, vi, afterEach } from 'vitest';
import { callOpenAICompatible } from './openrouter.js';

/**
 * The OpenAI-compatible transport, which now serves two providers (OpenRouter
 * and NVIDIA's `integrate.api.nvidia.com`).
 *
 * The case worth pinning is the outgoing tool round-trip, because its failure
 * mode is delayed by one turn. `chat.ts` had exactly this defect and carries a
 * test for it; this transport did not, and the whole-system audit on
 * 2026-08-30 found it by reading the two side by side.
 */

const provider = {
  label: 'NVIDIA',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKey: 'nvapi-test',
  keyVar: 'NVIDIA_API_KEY',
  codePrefix: 'NVIDIA',
};

function stubOk() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'x',
        model: 'nvidia/nemotron-3-super-120b-a12b',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('a tool loop survives the second turn', () => {
  it('carries tool_calls and tool_call_id onto the outgoing messages', async () => {
    const fetchMock = stubOk();

    await callOpenAICompatible(
      {
        model: 'nvidia/nemotron-3-super-120b-a12b',
        messages: [
          { role: 'user', content: 'what is the weather' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Reno"}' },
              },
            ],
          },
          { role: 'tool', content: '{"tempF":71}', toolCallId: 'call_1' },
        ],
      } as never,
      provider
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    // Without these two the endpoint answers `400 invalid_request_error:
    // messages with role "tool" must be a response to a preceding message
    // with tool_calls` — and it does so on the turn AFTER the one that
    // produced the tool call, which is why this was invisible in a smoke test
    // that only ever asked one question.
    expect(body.messages[1].tool_calls).toHaveLength(1);
    expect(body.messages[1].tool_calls[0].id).toBe('call_1');
    expect(body.messages[2].tool_call_id).toBe('call_1');
  });

  it('omits both keys entirely on a plain message', async () => {
    const fetchMock = stubOk();

    await callOpenAICompatible(
      {
        model: 'nvidia/nemotron-3-super-120b-a12b',
        messages: [{ role: 'user', content: 'hi' }],
      } as never,
      provider
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Omitted, not sent as null/undefined: some endpoints validate the
    // presence of `tool_call_id` on a non-tool message rather than its value.
    expect('tool_call_id' in body.messages[0]).toBe(false);
    expect('tool_calls' in body.messages[0]).toBe(false);
  });
});

describe('the provider identity reaches the failure message', () => {
  it('names the provider and its key var when the key is unset', async () => {
    // The auditor's only correct response to a config failure is to stop the
    // run, so the message has to say which provider was unreachable and which
    // variable to set — "401" alone sends someone to the wrong dashboard.
    await expect(
      callOpenAICompatible(
        {
          model: 'nvidia/x',
          messages: [{ role: 'user', content: 'hi' }],
        } as never,
        { ...provider, apiKey: '' }
      )
    ).rejects.toThrow(/NVIDIA_API_KEY is not set/);
  });
});

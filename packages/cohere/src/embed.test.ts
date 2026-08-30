/**
 * embed.ts's own docstring documents a real historical bug: the old shape
 * (`meta.billedTokens.inputTokens/outputTokens`) never matched Cohere's
 * actual snake_case, nested `meta.billed_units.input_tokens` response, so
 * every embed() call threw a TypeError before returning. These tests pin
 * the fixed mapping against a literal Cohere-shaped response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CohereEnv } from './index.js';

const env: CohereEnv = { COHERE_API_KEY: 'test-key' };

function mockFetchOnce(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('embed() response mapping', () => {
  it('reads input_tokens out of the nested billed_units shape', async () => {
    const { embed } = await import('./embed.js');
    mockFetchOnce({
      id: 'embed-1',
      embeddings: { float: [[0.1, 0.2, 0.3]] },
      meta: { billed_units: { input_tokens: 7 } },
    });

    const result = await embed(
      { model: 'embed-v4.0', texts: ['hello'], inputType: 'search_query' },
      env
    );

    expect(result.data.meta.billedTokens).toEqual({ inputTokens: 7 });
    expect(result.cost).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      billedTokens: 7,
    });
    expect(result.data.embeddings.float).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('does not throw when meta or billed_units is missing, defaulting to 0', async () => {
    const { embed } = await import('./embed.js');
    mockFetchOnce({
      id: 'embed-2',
      embeddings: { float: [[0.0]] },
    });

    const result = await embed(
      { model: 'embed-v4.0', texts: ['hello'], inputType: 'search_query' },
      env
    );

    expect(result.data.meta.billedTokens).toEqual({ inputTokens: 0 });
    expect(result.cost?.billedTokens).toBe(0);
  });

  it('carries warnings through when present', async () => {
    const { embed } = await import('./embed.js');
    mockFetchOnce({
      id: 'embed-3',
      embeddings: { float: [[0.1]] },
      meta: {
        billed_units: { input_tokens: 3 },
        warnings: ['deprecated model'],
      },
    });

    const result = await embed(
      { model: 'embed-v4.0', texts: ['hi'], inputType: 'search_document' },
      env
    );

    expect(result.data.meta.warnings).toEqual(['deprecated model']);
  });
});

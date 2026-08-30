/**
 * Cohere answers 429 for two unrelated conditions. A per-minute burst limit
 * clears in seconds; a monthly call quota does not clear until the billing
 * month rolls over (trial keys, and prod keys on newer chat model variants,
 * are capped at 1,000 calls a month). Treating both as retryable spends three
 * more calls against an already-exhausted quota and delays a certain failure by
 * ~14s of backoff. Captured in production 2026-08-25 on an enterprise pipeline
 * run that died at step 1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CohereEnv } from './index.js';

const env: CohereEnv = { COHERE_API_KEY: 'test-key' };

function mockAll429(message: string) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ message }), { status: 429 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('cohereRequest() 429 handling', () => {
  it('fails immediately on a monthly quota 429 without retrying', async () => {
    const { cohereRequest } = await import('./index.js');
    const fetchMock = mockAll429(
      'You are past the per-month request limit for this model, please wait and try again later.'
    );

    await expect(
      cohereRequest('chat', { model: 'command-a-plus-05-2026' }, env)
    ).rejects.toMatchObject({ code: 'COHERE_MONTHLY_QUOTA_EXHAUSTED' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a per-minute 429', async () => {
    const { cohereRequest } = await import('./index.js');
    const fetchMock = mockAll429(
      'You are past the per minute rate limit, please wait and try again later.'
    );

    await expect(
      cohereRequest('chat', { model: 'command-a-03-2025' }, env)
    ).rejects.toMatchObject({ code: 'COHERE_HTTP_429' });

    // Initial attempt plus MAX_RETRIES.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 30_000);
});

/**
 * 422 must stay fail-fast in general: a malformed body is a bug in this repo and
 * has to surface on the first response, which is how five separate v2 wire-shape
 * defects were caught. The single exception is NO_VALID_RESPONSE_GENERATED,
 * which reports a failed generation rather than a bad request — observed in
 * production 2026-08-27 killing an auditor step in 295ms, with the identical
 * request succeeding on the next run.
 */
describe('cohereRequest() 422 handling', () => {
  function mockAll422(body: unknown) {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(body), { status: 422 })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('retries NO_VALID_RESPONSE_GENERATED', async () => {
    const { cohereRequest } = await import('./index.js');
    const fetchMock = mockAll422({
      error_type: 'NO_VALID_RESPONSE_GENERATED',
      id: 'c78199c4-1730-46fa-a4d3-4ce6c8466b8a',
      message: 'No valid response generated. Try updating messages',
    });

    await expect(
      cohereRequest('chat', { model: 'command-a-03-2025' }, env)
    ).rejects.toMatchObject({ code: 'COHERE_HTTP_422' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('succeeds when the retry generates a response', async () => {
    const { cohereRequest } = await import('./index.js');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({ error_type: 'NO_VALID_RESPONSE_GENERATED' }),
            { status: 422 }
          )
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await cohereRequest(
      'chat',
      { model: 'command-a-03-2025' },
      env
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('still fails fast on a wire-shape 422', async () => {
    const { cohereRequest } = await import('./index.js');
    // The shape of the real `thinking`/`citation_quality` rejections: an
    // unknown-field complaint that no amount of backoff will change.
    const fetchMock = mockAll422({
      id: '2bd36e2f-b765-4ebb-9505-6403c0c9e1a4',
      message: "unknown field: parameter 'tokenBudget' is not a valid field",
    });

    await expect(
      cohereRequest('chat', { model: 'command-a-03-2025' }, env)
    ).rejects.toMatchObject({ code: 'COHERE_HTTP_422' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

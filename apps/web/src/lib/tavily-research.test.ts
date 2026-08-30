/**
 * Tavily integration tests.
 *
 * Fixtures are real response bodies captured from api.tavily.com with a live
 * key on 2026-08-25, trimmed to the fields this module reads. The Scite
 * module shipped broken for a long time because its tests were written
 * against an invented shape and passed happily; do not adjust an expectation
 * here to match the code. Re-capture from the API instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  tavilySearch,
  tavilySearchScholarly,
  tavilyExtract,
  tavilyCorpus,
  SCHOLARLY_DOMAINS,
} from './tavily-research.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = { TAVILY_API_KEY: 'test-key' };

// POST /search — captured 2026-08-25.
const SEARCH_FIXTURE = {
  query: 'RFC 6962 certificate transparency merkle tree hash',
  follow_up_questions: null,
  answer: null,
  images: [],
  request_id: '468e77c5-d8de-405d-82f8-06747cec7139',
  response_time: 3.46,
  results: [
    {
      url: 'https://letsencrypt.org/2025/08/14/rfc-6962-logs-eol',
      title: 'End of Life Plan for RFC 6962 Certificate Transparency Logs',
      content: 'Certificate Transparency logs are a binary tree…',
      score: 0.81979275,
      raw_content: null,
      id: '6a56ad-00',
    },
    {
      url: 'https://www.rfc-editor.org/info/rfc6962',
      title: 'RFC 6962: Certificate Transparency | RFC Editor',
      content: 'Merkle Hash Trees, Merkle Audit Paths…',
      score: 0.76,
      raw_content: 'doi:10.17487/RFC6962 full text',
      id: '6a56ad-01',
    },
  ],
};

// POST /extract — captured 2026-08-25.
const EXTRACT_FIXTURE = {
  results: [
    {
      url: 'https://www.rfc-editor.org/info/rfc6962',
      title: 'RFC 6962',
      raw_content: 'RFC 6962 Certificate Transparency June 2013…',
      images: [],
    },
  ],
  failed_results: [],
  request_id: 'abc',
  response_time: 1.2,
};

function stubJson(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('no key configured', () => {
  it('makes no request and returns an empty result set', async () => {
    const fetchMock = stubJson(SEARCH_FIXTURE);
    expect(await tavilySearch('merkle tree', {})).toEqual({ results: [] });
    expect((await tavilyExtract(['https://x.test'], {})).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an empty-string key as absent', async () => {
    const fetchMock = stubJson(SEARCH_FIXTURE);
    await tavilySearch('merkle tree', { TAVILY_API_KEY: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tavilySearch', () => {
  it('parses the real result shape', async () => {
    stubJson(SEARCH_FIXTURE);
    const out = await tavilySearch('merkle tree', KEY);

    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toEqual({
      url: 'https://letsencrypt.org/2025/08/14/rfc-6962-logs-eol',
      title: 'End of Life Plan for RFC 6962 Certificate Transparency Logs',
      content: 'Certificate Transparency logs are a binary tree…',
      score: 0.81979275,
    });
    expect(out.requestId).toBe('468e77c5-d8de-405d-82f8-06747cec7139');
  });

  it('carries raw_content through only where the API supplied it', async () => {
    stubJson(SEARCH_FIXTURE);
    const out = await tavilySearch('merkle tree', KEY);
    // First result's raw_content is null, not a string.
    expect(out.results[0].rawContent).toBeUndefined();
    expect(out.results[1].rawContent).toBe('doi:10.17487/RFC6962 full text');
  });

  it('sends bearer auth and the documented body fields', async () => {
    const fetchMock = stubJson(SEARCH_FIXTURE);
    await tavilySearch('merkle tree', KEY, {
      maxResults: 5,
      searchDepth: 'advanced',
      includeAnswer: 'basic',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toMatchObject({
      query: 'merkle tree',
      max_results: 5,
      search_depth: 'advanced',
      include_answer: 'basic',
    });
  });

  it('does not spend a credit on a query the API would reject', async () => {
    const fetchMock = stubJson(SEARCH_FIXTURE);
    // Measured: Tavily 400s below 2 characters.
    expect(await tavilySearch('a', KEY)).toEqual({ results: [] });
    expect(await tavilySearch('   ', KEY)).toEqual({ results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty — never throws — on 401', async () => {
    stubJson(
      { detail: { error: 'Unauthorized: missing or invalid API key.' } },
      401
    );
    expect(await tavilySearch('merkle tree', KEY)).toEqual({ results: [] });
  });

  it('returns empty on the 400 that validation produces', async () => {
    // Validation runs BEFORE auth, so a 400 says nothing about the key.
    stubJson({ detail: { error: 'Query is too short.' } }, 400);
    expect(await tavilySearch('merkle tree', KEY)).toEqual({ results: [] });
  });

  it('does not throw when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await tavilySearch('merkle tree', KEY)).toEqual({ results: [] });
  });

  it('drops a result with no url rather than emitting a blank one', async () => {
    stubJson({ results: [{ title: 'no url', content: 'x', score: 0.5 }] });
    expect((await tavilySearch('merkle tree', KEY)).results).toEqual([]);
  });
});

describe('tavilySearchScholarly', () => {
  it('scopes to DOI-publishing domains at advanced depth', async () => {
    const fetchMock = stubJson(SEARCH_FIXTURE);
    await tavilySearchScholarly('merkle tree', KEY);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Measured: the unscoped search over the same query yielded 0 DOIs and
    // the scoped one yielded DOIs. Both parts matter — scoping and depth.
    expect(body.include_domains).toEqual(SCHOLARLY_DOMAINS);
    expect(body.search_depth).toBe('advanced');
    expect(body.include_raw_content).toBe(true);
  });
});

describe('tavilyExtract', () => {
  it('maps url to full page text', async () => {
    stubJson(EXTRACT_FIXTURE);
    const out = await tavilyExtract(
      ['https://www.rfc-editor.org/info/rfc6962'],
      KEY
    );
    expect(out.get('https://www.rfc-editor.org/info/rfc6962')).toContain(
      'June 2013'
    );
  });

  it('makes no request for an empty url list', async () => {
    const fetchMock = stubJson(EXTRACT_FIXTURE);
    expect((await tavilyExtract([], KEY)).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tavilyCorpus', () => {
  it('includes raw content, which is where the DOIs actually are', async () => {
    stubJson(SEARCH_FIXTURE);
    const corpus = tavilyCorpus(await tavilySearch('merkle tree', KEY));
    // The trimmed `content` snippet does not carry it; raw_content does.
    expect(corpus).toContain('10.17487/RFC6962');
    expect(corpus).toContain('https://www.rfc-editor.org/info/rfc6962');
  });

  it('handles a result set with no answer and no raw content', () => {
    expect(
      tavilyCorpus({
        results: [{ url: 'u', title: 't', content: 'c', score: 0.1 }],
      })
    ).toContain('u t c');
  });
});

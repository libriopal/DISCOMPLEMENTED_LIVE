/**
 * Scite integration tests.
 *
 * Every fixture in this file is a **real response body**, captured from
 * api.scite.ai with a live key on 2026-08-25. That is deliberate: the
 * previous version of this module was written against an invented response
 * shape and got the endpoint, the request body, and the name of the
 * `contradicting` field all wrong. Fixtures copied from the live API are the
 * only thing that would have caught any of it.
 *
 * If a test here needs changing, re-capture the fixture from the API first.
 * Do not adjust the expectation to match the code.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractDois,
  getSciteTallies,
  getSciteTalliesBatch,
  getScitePapers,
  enrichDoisWithScite,
  assessCitationSupport,
  type ScitePaper,
} from './scite-research.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// GET /tallies/10.1145/3576915.3623209 — captured 2026-08-25.
const TALLY_FIXTURE = {
  total: 30,
  supporting: 0,
  contradicting: 0,
  mentioning: 30,
  unclassified: 0,
  doi: '10.1145/3576915.3623209',
  citingPublications: 49,
};

// POST /tallies ["10.1038/nature14539"] — captured 2026-08-25.
const BATCH_TALLY_FIXTURE = {
  tallies: {
    '10.1038/nature14539': {
      total: 45561,
      supporting: 110,
      contradicting: 5,
      mentioning: 44825,
      unclassified: 621,
      doi: '10.1038/nature14539',
      citingPublications: 90197,
    },
  },
};

// POST /papers ["10.1038/nature14539"] — captured 2026-08-25, trimmed to the
// fields this module reads.
const BATCH_PAPER_FIXTURE = {
  papers: {
    '10.1038/nature14539': {
      id: 81331864,
      doi: '10.1038/nature14539',
      title: 'Deep learning',
      abstract: 'Deep learning allows computational models…',
      authors: [
        { family: 'LeCun', given: 'Yann', affiliation: 'Meta (United States)' },
        { family: 'Bengio', given: 'Yoshua' },
      ],
      year: 2015,
      journal: 'Nature',
      shortJournal: 'Nature',
      publisher: 'Springer Science and Business Media LLC',
      retracted: false,
      editorialNotices: [],
      slug: 'deep-learning-ymzv3M',
    },
  },
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

const KEY = { SCITE_API_KEY: 'test-key' };

describe('extractDois', () => {
  it('pulls DOIs out of prose and doi.org URLs, deduped and lowercased', () => {
    const dois = extractDois(
      'See https://doi.org/10.1038/nature14539 and 10.1145/3576915.3623209. ' +
        'Also 10.1038/NATURE14539 again.'
    );
    expect(dois.sort()).toEqual([
      '10.1038/nature14539',
      '10.1145/3576915.3623209',
    ]);
  });

  it('trims trailing sentence punctuation off a DOI', () => {
    expect(extractDois('cited in 10.1038/nature14539.')).toEqual([
      '10.1038/nature14539',
    ]);
    expect(extractDois('(see 10.1038/nature14539)')).toEqual([
      '10.1038/nature14539',
    ]);
  });

  it('finds nothing in text with no DOI', () => {
    expect(extractDois('version 10.15 of the spec')).toEqual([]);
  });
});

describe('no key configured', () => {
  it('makes no request at all', async () => {
    const fetchMock = stubJson(TALLY_FIXTURE);
    expect(await getSciteTallies('10.1/a', {})).toBeNull();
    expect(await enrichDoisWithScite(['10.1/a'], {})).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an empty-string key as absent', async () => {
    const fetchMock = stubJson(TALLY_FIXTURE);
    await getSciteTallies('10.1/a', { SCITE_API_KEY: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getSciteTallies', () => {
  it('parses the real tally shape, including `contradicting`', async () => {
    stubJson(TALLY_FIXTURE);
    expect(await getSciteTallies('10.1145/3576915.3623209', KEY)).toEqual({
      supporting: 0,
      contradicting: 0,
      mentioning: 30,
      unclassified: 0,
      total: 30,
      citingPublications: 49,
    });
  });

  it('returns null — not zeros — when Scite has never seen the DOI', async () => {
    // 404 and "indexed with no citations" must stay distinguishable.
    stubJson({ detail: 'Not Found' }, 404);
    expect(await getSciteTallies('10.9999/nope', KEY)).toBeNull();
  });

  it('returns null on the 400 a bad bearer actually produces', async () => {
    stubJson({ detail: 'Invalid authorization token' }, 400);
    expect(await getSciteTallies('10.1/a', KEY)).toBeNull();
  });

  it('returns null on the 403 a partner-tier endpoint produces', async () => {
    stubJson({ detail: 'User not authorized' }, 403);
    expect(await getSciteTallies('10.1/a', KEY)).toBeNull();
  });

  it('does not throw when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await getSciteTallies('10.1/a', KEY)).toBeNull();
  });
});

describe('batch endpoints', () => {
  it('POSTs a bare DOI array, not an object', async () => {
    const fetchMock = stubJson(BATCH_TALLY_FIXTURE);
    await getSciteTalliesBatch(['10.1038/nature14539'], KEY);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.scite.ai/tallies');
    expect(init.method).toBe('POST');
    // The object form returns 400 {"message":"Invalid request."} — measured.
    expect(JSON.parse(init.body)).toEqual(['10.1038/nature14539']);
  });

  it('keys tallies by DOI', async () => {
    stubJson(BATCH_TALLY_FIXTURE);
    const out = await getSciteTalliesBatch(['10.1038/nature14539'], KEY);
    expect(out.get('10.1038/nature14539')).toMatchObject({
      supporting: 110,
      contradicting: 5,
      mentioning: 44825,
      total: 45561,
    });
  });

  it('flattens Scite author objects into names', async () => {
    stubJson(BATCH_PAPER_FIXTURE);
    const out = await getScitePapers(['10.1038/nature14539'], KEY);
    expect(out.get('10.1038/nature14539')).toMatchObject({
      title: 'Deep learning',
      authors: ['Yann LeCun', 'Yoshua Bengio'],
      year: 2015,
      journal: 'Nature',
      retracted: false,
      url: 'https://doi.org/10.1038/nature14539',
    });
  });

  it('makes no request for an empty DOI list', async () => {
    const fetchMock = stubJson(BATCH_TALLY_FIXTURE);
    expect((await getSciteTalliesBatch([], KEY)).size).toBe(0);
    expect((await getScitePapers([], KEY)).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enrichDoisWithScite', () => {
  it('joins papers to tallies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith('/papers')
                ? BATCH_PAPER_FIXTURE
                : BATCH_TALLY_FIXTURE
            ),
            { status: 200 }
          )
      )
    );
    const out = await enrichDoisWithScite(['10.1038/NATURE14539'], KEY);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Deep learning');
    expect(out[0].citations.contradicting).toBe(5);
  });

  it('drops DOIs Scite has not indexed rather than zero-filling them', async () => {
    stubJson({ papers: {} });
    expect(await enrichDoisWithScite(['10.9999/nope'], KEY)).toEqual([]);
  });
});

function paper(over: Partial<ScitePaper>): ScitePaper {
  return {
    doi: '10.1/x',
    title: 't',
    abstract: '',
    authors: [],
    year: 2020,
    journal: '',
    publisher: '',
    retracted: false,
    editorialNotices: [],
    url: '',
    citations: {
      supporting: 0,
      contradicting: 0,
      mentioning: 0,
      unclassified: 0,
      total: 0,
      citingPublications: 0,
    },
    ...over,
  };
}

describe('assessCitationSupport', () => {
  it('confidence is over classified citations only, ignoring `mentioning`', () => {
    // Real ratio: 110 supporting, 5 contradicting, 44,825 mentioning.
    // Including `mentioning` would report 0.2% and read as "unsupported".
    const out = assessCitationSupport([
      paper({
        citations: {
          supporting: 110,
          contradicting: 5,
          mentioning: 44825,
          unclassified: 621,
          total: 45561,
          citingPublications: 90197,
        },
      }),
    ]);
    expect(out.confidence).toBeCloseTo(110 / 115, 5);
  });

  it('confidence is null — not 0 — when nothing was classified', () => {
    const out = assessCitationSupport([
      paper({
        citations: {
          supporting: 0,
          contradicting: 0,
          mentioning: 30,
          unclassified: 0,
          total: 30,
          citingPublications: 49,
        },
      }),
    ]);
    expect(out.confidence).toBeNull();
  });

  it('flags retracted papers and those carrying an editorial notice', () => {
    const out = assessCitationSupport([
      paper({ doi: '10.1/a', retracted: true }),
      paper({ doi: '10.1/b', editorialNotices: ['Expression of concern'] }),
      paper({ doi: '10.1/c' }),
    ]);
    expect(out.flagged.map((p) => p.doi)).toEqual(['10.1/a', '10.1/b']);
  });

  it('splits supporting from contradicting by which side leads', () => {
    const sup = paper({
      doi: '10.1/sup',
      citations: { ...paper({}).citations, supporting: 9, contradicting: 1 },
    });
    const con = paper({
      doi: '10.1/con',
      citations: { ...paper({}).citations, supporting: 1, contradicting: 9 },
    });
    const out = assessCitationSupport([sup, con]);
    expect(out.supporting.map((p) => p.doi)).toEqual(['10.1/sup']);
    expect(out.contradicting.map((p) => p.doi)).toEqual(['10.1/con']);
  });

  it('handles an empty set without dividing by zero', () => {
    expect(assessCitationSupport([])).toEqual({
      supporting: [],
      contradicting: [],
      flagged: [],
      confidence: null,
    });
  });
});

/**
 * Tavily — web search and page extraction for the research engine.
 *
 * Every statement below was measured against api.tavily.com with a live key
 * on 2026-08-25, not read off the docs. The Scite module was written blind
 * and turned out to be built on an endpoint that does not exist; this one
 * records what the API actually did.
 *
 * Confirmed:
 * - `POST /search` 200. Body `{query, ...}`; response
 *   `{query, answer, results[], images, follow_up_questions, request_id,
 *   response_time}`. Each result is
 *   `{url, title, content, score, raw_content, id}` — `score` is 0–1.
 * - `POST /extract` 200. Body `{urls: string[], extract_depth}`; response
 *   `{results[{url, title, raw_content, images}], failed_results[], ...}`.
 *   Returned 6,079 chars of clean text for an RFC page.
 * - `POST /map`, `POST /crawl` exist. `POST /research` exists and takes an
 *   `input` field — Tavily's deep-research endpoint. Deliberately NOT wired
 *   up here: it bills heavily against a 1,500-credit plan and that is an
 *   owner decision, not a default.
 * - Auth is `Authorization: Bearer`. Errors are `{"detail":{"error":"…"}}`,
 *   401 for a bad or missing key, 400 for validation.
 *
 * The one real trap: **validation runs before auth.** A too-short query
 * returns 400 even with a garbage key, so a 400 is not evidence the key is
 * good. Treat only a 200 as proof of anything.
 *
 * Measured DOI yield, which is why searchScholarly() exists at all:
 *
 *   generic search, 10 results                          -> 0 unique DOIs
 *   same query, include_domains=[arxiv, pubmed,
 *     doi.org, nature, dl.acm.org], depth=advanced      -> 2 unique DOIs
 *
 * Scite cannot search on this account (see lib/scite-research.ts), so its
 * citation and retraction signal is only as good as the DOIs handed to it.
 * A domain-scoped Tavily pass is what feeds it.
 */

const TAVILY_BASE = 'https://api.tavily.com';

/**
 * Domains that actually carry DOIs. Measured: an unscoped search over the
 * same query yielded none at all, so this list is the difference between
 * Scite having input and Scite having nothing.
 */
export const SCHOLARLY_DOMAINS = [
  'arxiv.org',
  'pubmed.ncbi.nlm.nih.gov',
  'doi.org',
  'nature.com',
  'dl.acm.org',
  'ieeexplore.ieee.org',
  'link.springer.com',
  'sciencedirect.com',
];

export interface TavilyResult {
  url: string;
  title: string;
  /** Tavily's own extracted snippet — already trimmed to the relevant part. */
  content: string;
  /** 0–1 relevance, Tavily's own scoring. Not comparable to Cohere's. */
  score: number;
  /** Only present when `includeRawContent` was set. */
  rawContent?: string;
}

export interface TavilySearchResult {
  results: TavilyResult[];
  /** Only present when `includeAnswer` was set. */
  answer?: string;
  /** Tavily's request id — worth logging; it is what support asks for. */
  requestId?: string;
}

export interface TavilyEnv {
  TAVILY_API_KEY?: string;
}

export interface TavilySearchOptions {
  maxResults?: number;
  /** 'advanced' costs more credits than 'basic'. Default here is 'basic'. */
  searchDepth?: 'basic' | 'advanced';
  includeAnswer?: false | 'basic' | 'advanced';
  includeDomains?: string[];
  includeRawContent?: boolean;
}

/**
 * Single choke point for every Tavily call.
 *
 * Returns `null` — never a partial or zero-filled object — for: no key,
 * network failure, and any non-2xx. A caller must be able to tell "Tavily
 * had nothing to say" from "Tavily was never asked", and the only way to
 * keep that distinction is to refuse to invent a shape.
 */
async function tavilyFetch(
  path: string,
  body: Record<string, unknown>,
  env: TavilyEnv
): Promise<unknown | null> {
  // An empty string is a *present* key to `if (key)`. Check truthiness, and
  // never coerce an absent key with `?? ''` — that sends an empty bearer to
  // a third party, which is how the Scite path used to behave.
  if (!env.TAVILY_API_KEY) return null;

  let response: Response;
  try {
    response = await fetch(`${TAVILY_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`Tavily ${path} network error:`, err);
    return null;
  }

  if (!response.ok) {
    // 400 can mean a malformed request rather than a bad key — validation
    // runs first — so log the status rather than concluding anything.
    console.warn(`Tavily ${path} -> HTTP ${response.status}`);
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toResults(raw: unknown): TavilyResult[] {
  const results = (raw as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((r) => {
    const item = r as Record<string, unknown>;
    const url = typeof item.url === 'string' ? item.url : '';
    if (!url) return [];
    return [
      {
        url,
        title: typeof item.title === 'string' ? item.title : 'Untitled',
        content: typeof item.content === 'string' ? item.content : '',
        score: typeof item.score === 'number' ? item.score : 0,
        ...(typeof item.raw_content === 'string' && {
          rawContent: item.raw_content,
        }),
      },
    ];
  });
}

/** Web search. Returns an empty result set — never throws — on any failure. */
export async function tavilySearch(
  query: string,
  env: TavilyEnv,
  options: TavilySearchOptions = {}
): Promise<TavilySearchResult> {
  // Tavily 400s below 2 characters; there is no point spending a credit.
  if (query.trim().length < 2) return { results: [] };

  const raw = await tavilyFetch(
    '/search',
    {
      query,
      max_results: options.maxResults ?? 10,
      search_depth: options.searchDepth ?? 'basic',
      ...(options.includeAnswer && { include_answer: options.includeAnswer }),
      ...(options.includeDomains?.length && {
        include_domains: options.includeDomains,
      }),
      ...(options.includeRawContent && { include_raw_content: true }),
    },
    env
  );
  if (!raw) return { results: [] };

  const body = raw as Record<string, unknown>;
  return {
    results: toResults(raw),
    ...(typeof body.answer === 'string' && { answer: body.answer }),
    ...(typeof body.request_id === 'string' && { requestId: body.request_id }),
  };
}

/**
 * Search restricted to domains that publish DOIs, to feed Scite.
 *
 * `advanced` depth is deliberate here and only here: the shallow pass
 * returned no DOIs at all on the query measured, which makes the phase
 * pointless. It costs more credits, so this runs once per research run.
 */
export async function tavilySearchScholarly(
  query: string,
  env: TavilyEnv,
  maxResults = 10
): Promise<TavilySearchResult> {
  return tavilySearch(query, env, {
    maxResults,
    searchDepth: 'advanced',
    includeDomains: SCHOLARLY_DOMAINS,
    includeRawContent: true,
  });
}

/** Full page text for URLs already found. Empty map on any failure. */
export async function tavilyExtract(
  urls: string[],
  env: TavilyEnv
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;

  const raw = await tavilyFetch(
    '/extract',
    { urls, extract_depth: 'basic' },
    env
  );
  if (!raw) return out;

  const results = (raw as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return out;

  for (const r of results) {
    const item = r as Record<string, unknown>;
    if (typeof item.url === 'string' && typeof item.raw_content === 'string') {
      out.set(item.url, item.raw_content);
    }
  }
  return out;
}

/**
 * Everything Tavily saw, as one blob for DOI extraction.
 *
 * `content` alone often omits the DOI that sits in the page furniture, so
 * `rawContent` is included where it was requested.
 */
export function tavilyCorpus(search: TavilySearchResult): string {
  return [
    search.answer ?? '',
    ...search.results.map(
      (r) => `${r.url} ${r.title} ${r.content} ${r.rawContent ?? ''}`
    ),
  ].join('\n');
}

/**
 * You.com Research API — real-time web intelligence for the research stage.
 *
 * You.com provides 5 APIs:
 * 1. Web Search — real-time web and news results as JSON
 * 2. Answer — cited, synthesized answer from a single query
 * 3. Contents — clean Markdown/HTML from URLs
 * 4. Research — multi-step, cited answers to complex questions
 * 5. Finance Research — cited answers from a finance-optimized index
 *
 * The Research API is the most powerful — it runs multiple searches,
 * reads sources, and synthesizes citation-backed answers. This is
 * exactly what we need for the Discomplement research stage.
 *
 * Auth: X-API-Key header (YDC_API_KEY env var)
 * Base URL: https://api.ydc-index.io (or https://api.you.com)
 *
 * This is the "discovery" in dis[cover]co[here][i]mplemented —
 * the system discovers real-time web intelligence before writing code.
 */

export interface YouComSearchResult {
  url: string;
  title: string;
  description: string;
  snippets: string[];
  page_age: string | null;
  favicon_url: string | null;
  contents?: {
    markdown?: string;
    html?: string;
  };
}

export interface YouComAnswerResult {
  answer: string;
  citations: Array<{
    source: string;
    excerpts: string[];
  }>;
  results: {
    web: Array<{
      url: string;
      title: string;
      snippets: string[];
    }>;
  };
}

export interface YouComResearchResult {
  output: {
    content: string;
    content_type: string;
    sources: Array<{
      url: string;
      title: string;
      snippets: string[];
    }>;
  };
  metadata: {
    research_uuid: string;
    latency: number;
  };
}

export interface YouComContentsResult {
  url: string;
  title: string;
  markdown: string;
  metadata: {
    site_name: string;
    favicon_url: string;
  };
}

const YOUCOM_BASE = 'https://ydc-index.io/v1';

/**
 * Web Search API — real-time web and news results as structured JSON.
 * Feed results directly into prompts to ground AI in fresh information.
 */
export async function youComSearch(
  query: string,
  env: { YDC_API_KEY: string },
  opts: {
    count?: number;
    country?: string;
    lang?: string;
    safesearch?: 'off' | 'moderate' | 'strict';
    freshness?: string;
    includeDomains?: string[];
    excludeDomains?: string[];
    extractionMode?: 'full_page' | 'none';
  } = {}
): Promise<{
  results: YouComSearchResult[];
  metadata: { query: string; latency: number };
}> {
  if (!env?.YDC_API_KEY) {
    console.warn('YDC_API_KEY not set — skipping You.com search');
    return { results: [], metadata: { query, latency: 0 } };
  }

  const params = new URLSearchParams({
    q: query,
    count: String(opts.count ?? 10),
  });

  if (opts.country) params.set('country', opts.country);
  if (opts.lang) params.set('lang', opts.lang);
  if (opts.safesearch) params.set('safesearch', opts.safesearch);
  if (opts.freshness) params.set('freshness', opts.freshness);
  if (opts.includeDomains)
    params.set('include_domains', opts.includeDomains.join(','));
  if (opts.excludeDomains)
    params.set('exclude_domains', opts.excludeDomains.join(','));
  if (opts.extractionMode === 'full_page') {
    params.set('extraction_mode', 'full_page');
  }

  const response = await fetch(`${YOUCOM_BASE}/search`, {
    method: 'POST',
    headers: {
      'X-API-Key': env.YDC_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      count: opts.count ?? 10,
      country: opts.country,
      lang: opts.lang,
      safesearch: opts.safesearch,
      freshness: opts.freshness,
      include_domains: opts.includeDomains,
      exclude_domains: opts.excludeDomains,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`You.com search failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    results: {
      web: Array<{
        url: string;
        title: string;
        description: string;
        snippets: string[];
        page_age: string | null;
        favicon_url: string | null;
        contents?: { markdown?: string; html?: string };
      }>;
    };
    metadata: { query: string; latency: number };
  };

  return {
    results: data.results.web.map((r) => ({
      url: r.url,
      title: r.title,
      description: r.description,
      snippets: r.snippets,
      page_age: r.page_age,
      favicon_url: r.favicon_url,
      contents: r.contents,
    })),
    metadata: data.metadata,
  };
}

/**
 * Batch search — run multiple You.com queries in parallel.
 * Used by the Researcher to validate multiple framework parameters at once.
 */
export async function youComBatchSearch(
  queries: string[],
  env: { YDC_API_KEY: string },
  opts?: { maxResultsPerQuery?: number }
): Promise<Map<string, YouComSearchResult[]>> {
  const maxPerQuery = opts?.maxResultsPerQuery ?? 5;
  const results = new Map<string, YouComSearchResult[]>();

  // Run queries in parallel (You.com handles concurrent requests)
  const searchPromises = queries.map(async (query) => {
    try {
      const searchRes = await youComSearch(query, env, { count: maxPerQuery });
      results.set(query, searchRes.results ?? []);
    } catch (err) {
      console.error(`youComBatchSearch failed for query "${query}":`, err);
      results.set(query, []);
    }
  });

  await Promise.allSettled(searchPromises);
  return results;
}

/**
 * Verify an external dependency exists and is current using You.com.
 * Used by the Verifier agent to check that libraries/APIs mentioned in
 * research findings are real and actively maintained.
 */
export async function verifyDependency(
  dependencyName: string,
  env: { YDC_API_KEY: string }
): Promise<{
  name: string;
  found: boolean;
  status: 'approved' | 'risky' | 'unknown';
  notes: string;
}> {
  try {
    const searchRes = await youComSearch(
      `${dependencyName} npm package documentation latest version`,
      env,
      { count: 3 }
    );

    const results = searchRes.results ?? [];
    if (results.length === 0) {
      return {
        name: dependencyName,
        found: false,
        status: 'unknown',
        notes: 'No results from You.com — could not verify',
      };
    }

    const topResult = results[0];
    const snippet = topResult.snippets?.join(' ') ?? topResult.description ?? '';

    // Check if the dependency appears to be actively maintained
    const hasRecentVersion = /\d+\.\d+\.\d+/.test(snippet);
    const hasNpmLink = topResult.url?.includes('npmjs.com') ?? false;

    return {
      name: dependencyName,
      found: true,
      status: hasNpmLink && hasRecentVersion ? 'approved' : 'risky',
      notes: `${topResult.title}: ${snippet.slice(0, 200)}`,
    };
  } catch (err) {
    console.error(`verifyDependency failed for ${dependencyName}:`, err);
    return {
      name: dependencyName,
      found: false,
      status: 'unknown',
      notes: 'Error querying You.com — could not verify',
    };
  }
}

/**
 * Answer API — a cited, synthesized answer from a single query.
 * Every citation is verified against the source text.
 */
export async function youComAnswer(
  query: string,
  env: { YDC_API_KEY: string },
  opts: {
    country?: string;
    lang?: string;
    freshness?: string;
    includeDomains?: string[];
    excludeDomains?: string[];
  } = {}
): Promise<YouComAnswerResult> {
  const params = new URLSearchParams({ q: query });
  if (opts.country) params.set('country', opts.country);
  if (opts.lang) params.set('lang', opts.lang);
  if (opts.freshness) params.set('freshness', opts.freshness);
  if (opts.includeDomains)
    params.set('include_domains', opts.includeDomains.join(','));
  if (opts.excludeDomains)
    params.set('exclude_domains', opts.excludeDomains.join(','));

  const response = await fetch(`${YOUCOM_BASE}/answer?${params}`, {
    headers: { 'X-API-Key': env.YDC_API_KEY },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`You.com answer failed: ${response.status} ${error}`);
  }

  return response.json() as Promise<YouComAnswerResult>;
}

/**
 * Research API — multi-step, cited answers to complex questions.
 * Runs multiple searches, reads through sources, and synthesizes
 * a thorough, citation-backed answer.
 *
 * research_effort: 'lite' | 'standard' | 'extensive' | 'frontier'
 * This is the most powerful You.com API and the primary one we use
 * for the Discomplement research stage.
 */
export async function youComResearch(
  input: string,
  env: { YDC_API_KEY: string },
  opts: {
    researchEffort?: 'lite' | 'standard' | 'extensive' | 'frontier';
    outputFormat?: 'markdown' | 'text';
  } = {}
): Promise<YouComResearchResult> {
  const response = await fetch(`${YOUCOM_BASE}/research`, {
    method: 'POST',
    headers: {
      'X-API-Key': env.YDC_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input,
      research_effort: opts.researchEffort ?? 'standard',
      output_format: opts.outputFormat ?? 'markdown',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`You.com research failed: ${response.status} ${error}`);
  }

  return response.json() as Promise<YouComResearchResult>;
}

/**
 * Contents API — fetch clean Markdown or HTML from URLs.
 * Useful for extracting content from competitor pages or documentation.
 */
export async function youComContents(
  urls: string[],
  env: { YDC_API_KEY: string },
  format: 'markdown' | 'html' = 'markdown'
): Promise<YouComContentsResult[]> {
  const params = new URLSearchParams();
  urls.forEach((u) => params.append('url', u));
  params.set('format', format);

  const response = await fetch(`${YOUCOM_BASE}/contents?${params}`, {
    headers: { 'X-API-Key': env.YDC_API_KEY },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`You.com contents failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as YouComContentsResult[];
  return data;
}

/**
 * Fetch live news results for a topic.
 * Uses the Web Search API with news filter.
 */
export async function youComNews(
  query: string,
  env: { YDC_API_KEY: string },
  count: number = 5
): Promise<YouComSearchResult[]> {
  const result = await youComSearch(query, env, {
    count,
    freshness: 'week',
    extractionMode: 'none',
  });
  return result.results;
}

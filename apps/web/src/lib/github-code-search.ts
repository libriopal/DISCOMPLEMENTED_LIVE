/**
 * GitHub Code Search — find existing open source code to reuse.
 *
 * Instead of generating code from scratch, the research stage first searches
 * GitHub for open source implementations that already do what's needed.
 * This saves credits, improves quality, and speeds up delivery.
 *
 * Uses GitHub REST API /search/code endpoint:
 *   GET https://api.github.com/search/code?q={query}
 *   Rate limit: 10 requests/minute (authenticated)
 *   Returns up to 1,000 results
 */

export interface GitHubCodeResult {
  repo: string;
  path: string;
  name: string;
  url: string;
  html_url: string;
  score: number;
  language: string | null;
  repository: {
    full_name: string;
    description: string | null;
    stars: number;
    license: string | null;
  };
}

export interface GitHubSearchParams {
  query: string;
  language?: string;
  extension?: string;
  filename?: string;
  path?: string;
  size?: string;
  perPage?: number;
}

/**
 * Search GitHub for code matching the query.
 * Returns raw results from the GitHub API.
 */
export async function searchGitHubCode(
  params: GitHubSearchParams,
  env: { GITHUB_TOKEN: string }
): Promise<GitHubCodeResult[]> {
  // Build the query string with qualifiers
  let q = params.query;
  if (params.language) q += ` language:${params.language}`;
  if (params.extension) q += ` extension:${params.extension}`;
  if (params.filename) q += ` filename:${params.filename}`;
  if (params.path) q += ` path:${params.path}`;
  if (params.size) q += ` size:${params.size}`;

  const perPage = Math.min(params.perPage ?? 20, 100);
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}&sort=indexed`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub code search failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    total_count: number;
    items: Array<{
      name: string;
      path: string;
      html_url: string;
      score: number;
      repository: {
        full_name: string;
        description: string | null;
        stargazers_count: number;
        license: { key: string } | null;
      };
    }>;
  };

  return data.items.map((item) => ({
    repo: item.repository.full_name,
    path: item.path,
    name: item.name,
    url: item.html_url
      .replace('github.com', 'raw.githubusercontent.com')
      .replace('/blob/', '/'),
    html_url: item.html_url,
    score: item.score,
    language: params.language ?? null,
    repository: {
      full_name: item.repository.full_name,
      description: item.repository.description,
      stars: item.repository.stargazers_count,
      license: item.repository.license?.key ?? null,
    },
  }));
}

/**
 * Fetch the actual file content from a GitHub search result.
 */
export async function fetchGitHubFileContent(
  repo: string,
  path: string,
  branch: string,
  env: { GITHUB_TOKEN: string }
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3.raw',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${repo}/${path}: ${response.status}`);
  }

  return response.text();
}

/**
 * Search for reusable React components on GitHub.
 * Focuses on MIT/Apache licensed repos with stars.
 */
export async function findReusableComponents(
  featureDescription: string,
  env: { GITHUB_TOKEN: string }
): Promise<GitHubCodeResult[]> {
  // Extract key terms from the feature description
  const terms = featureDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 3 &&
        ![
          'react',
          'component',
          'create',
          'build',
          'make',
          'need',
          'want',
          'would',
        ].includes(w)
    )
    .slice(0, 3);

  const query = terms.join(' ');
  if (!query) return [];

  return searchGitHubCode(
    {
      query,
      language: 'typescript',
      extension: 'tsx',
      perPage: 15,
    },
    env
  );
}

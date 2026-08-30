/**
 * Scite integration — citation evidence for papers the research phase has
 * already found.
 *
 * API base: https://api.scite.ai   Auth: `Authorization: Bearer <key>`
 *
 * **This module was rewritten on 2026-08-25 against a live key.** Everything
 * before that was written blind, and most of it was wrong. What was measured,
 * and what it changed:
 *
 * - `POST /search` **does not exist** (404). The whole module was built on it.
 *   The real search endpoint is `GET /api_partner/search`, and our key gets
 *   **403 "User not authorized"** there — it is a standard key, not a partner
 *   key. `POST /reference_check` is 403 for the same reason. So there is no
 *   text-search capability on this account, and `searchScite()`/
 *   `checkReferences()` have been removed rather than left as functions that
 *   cannot work. Do not reintroduce a query-by-text call without first
 *   confirming the account has partner access.
 * - The citation field is **`contradicting`**, not `contrasting`. Every
 *   consumer read `contrasting`, so that count was silently always zero — it
 *   is the one number that would have made a "the literature disputes this"
 *   signal work at all.
 * - `GET /tallies/{doi}` returns `{total, supporting, contradicting,
 *   mentioning, unclassified, doi, citingPublications}`.
 * - `POST /tallies` and `POST /papers` take a **bare JSON array of DOI
 *   strings** (not an object) and return `{tallies: {...}}` / `{papers:
 *   {...}}` keyed by DOI. One request for N DOIs instead of N requests.
 * - Papers carry `retracted` and `editorialNotices`, which matter more than
 *   citation counts: a heavily-cited retracted paper is the exact failure
 *   this integration exists to catch.
 * - Errors come back in two different envelopes: `{"detail": "..."}` from the
 *   auth layer, `{"message": "Invalid request."}` from request validation.
 *
 * Endpoints confirmed reachable with the current key: `GET /tallies/{doi}`,
 * `POST /tallies`, `GET /papers/{doi}`, `POST /papers`,
 * `GET /tallies/cited-by-sections/{doi}`, `GET /papers/resolve-pmid/{pmid}`,
 * `GET /journal/{issn}/tallies`.
 */

const SCITE_BASE = 'https://api.scite.ai';

/** Batch endpoints are one request; keep the batch bounded anyway. */
const MAX_DOIS_PER_BATCH = 50;

export interface SciteCitations {
  supporting: number;
  /** Scite's field name. Was read as `contrasting` and always came back 0. */
  contradicting: number;
  mentioning: number;
  unclassified: number;
  total: number;
  /** Distinct citing works, which is smaller than `total` citation statements. */
  citingPublications: number;
}

export interface ScitePaper {
  doi: string;
  title: string;
  abstract: string;
  authors: string[];
  year: number;
  journal: string;
  publisher: string;
  /** True when Scite flags the work as retracted. Load-bearing — see below. */
  retracted: boolean;
  /** Retraction/correction/concern notices, if any. */
  editorialNotices: string[];
  citations: SciteCitations;
  url: string;
}

const ZERO_CITATIONS: SciteCitations = {
  supporting: 0,
  contradicting: 0,
  mentioning: 0,
  unclassified: 0,
  total: 0,
  citingPublications: 0,
};

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * DOIs as registered by Crossref: `10.` + registrant + `/` + suffix. The
 * trailing-punctuation trim matters because DOIs are usually lifted out of
 * prose or a URL, where they collide with sentence punctuation.
 */
const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g;

export function extractDois(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.match(DOI_PATTERN) ?? []) {
    const doi = raw.replace(/[.,;:)\]}>'"]+$/, '').toLowerCase();
    if (doi.length > 7) seen.add(doi);
  }
  return [...seen];
}

interface SciteEnv {
  SCITE_API_KEY?: string;
}

/**
 * Every call goes through here so the unconfigured and unauthorized cases
 * degrade identically: return null, let the caller skip the phase.
 *
 * `null` means "no Scite evidence available", never "no citations found" —
 * the difference matters, because zero citations is itself a finding and
 * must not be manufactured out of a failed request.
 */
async function sciteFetch(
  path: string,
  env: SciteEnv,
  init?: RequestInit
): Promise<unknown | null> {
  if (!env.SCITE_API_KEY) return null;

  let response: Response;
  try {
    response = await fetch(`${SCITE_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.SCITE_API_KEY}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    console.warn(`Scite ${path} — network error, skipping:`, err);
    return null;
  }

  if (!response.ok) {
    // 400 is Scite's answer to a malformed/missing bearer as well as to a bad
    // body — measured, it is not 401. 403 is "authenticated but this endpoint
    // is partner-tier". 404 on a DOI just means Scite has never seen it.
    // None of these are worth failing a research run over.
    if (response.status === 404) return null;
    if ([400, 401, 403, 429].includes(response.status)) {
      console.warn(
        `Scite ${path} unavailable (HTTP ${response.status}) — skipping Scite for this call`
      );
      return null;
    }
    console.warn(`Scite ${path} failed: HTTP ${response.status}`);
    return null;
  }

  try {
    return await response.json();
  } catch {
    console.warn(`Scite ${path} returned a non-JSON body — skipping`);
    return null;
  }
}

function toCitations(raw: unknown): SciteCitations {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    supporting: num(t.supporting),
    contradicting: num(t.contradicting),
    mentioning: num(t.mentioning),
    unclassified: num(t.unclassified),
    total: num(t.total),
    citingPublications: num(t.citingPublications),
  };
}

/** Scite returns authors as `{family, given, ...}` objects, not strings. */
function toAuthorNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => {
      if (typeof a === 'string') return a;
      const o = (a ?? {}) as Record<string, unknown>;
      return [str(o.given), str(o.family)].filter(Boolean).join(' ').trim();
    })
    .filter(Boolean);
}

function toEditorialNotices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n) => {
      if (typeof n === 'string') return n;
      const o = (n ?? {}) as Record<string, unknown>;
      return str(o.type) || str(o.title);
    })
    .filter(Boolean);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Citation tallies for one DOI. Returns null when Scite has no answer, so
 * callers can tell "not indexed" from "indexed with zero citations".
 */
export async function getSciteTallies(
  doi: string,
  env: SciteEnv
): Promise<SciteCitations | null> {
  const raw = await sciteFetch(`/tallies/${encodeURIComponent(doi)}`, env);
  return raw === null ? null : toCitations(raw);
}

/**
 * Tallies for many DOIs in a single request. `POST /tallies` takes a bare
 * array of DOI strings and answers `{tallies: {<doi>: {...}}}`.
 */
export async function getSciteTalliesBatch(
  dois: string[],
  env: SciteEnv
): Promise<Map<string, SciteCitations>> {
  const out = new Map<string, SciteCitations>();
  if (dois.length === 0) return out;

  for (const batch of chunk(dois, MAX_DOIS_PER_BATCH)) {
    const raw = await sciteFetch('/tallies', env, {
      method: 'POST',
      body: JSON.stringify(batch),
    });
    const tallies = ((raw ?? {}) as Record<string, unknown>).tallies;
    if (!tallies || typeof tallies !== 'object') continue;
    for (const [doi, t] of Object.entries(tallies as Record<string, unknown>)) {
      out.set(doi.toLowerCase(), toCitations(t));
    }
  }
  return out;
}

/**
 * Paper metadata for many DOIs. `POST /papers` mirrors `POST /tallies`:
 * bare array in, `{papers: {<doi>: {...}}}` out.
 */
export async function getScitePapers(
  dois: string[],
  env: SciteEnv
): Promise<Map<string, Omit<ScitePaper, 'citations'>>> {
  const out = new Map<string, Omit<ScitePaper, 'citations'>>();
  if (dois.length === 0) return out;

  for (const batch of chunk(dois, MAX_DOIS_PER_BATCH)) {
    const raw = await sciteFetch('/papers', env, {
      method: 'POST',
      body: JSON.stringify(batch),
    });
    const papers = ((raw ?? {}) as Record<string, unknown>).papers;
    if (!papers || typeof papers !== 'object') continue;

    for (const [key, p] of Object.entries(papers as Record<string, unknown>)) {
      const r = (p ?? {}) as Record<string, unknown>;
      const doi = (str(r.doi) || key).toLowerCase();
      out.set(doi, {
        doi,
        title: str(r.title),
        abstract: str(r.abstract),
        authors: toAuthorNames(r.authors),
        year: num(r.year),
        journal: str(r.journal) || str(r.shortJournal),
        publisher: str(r.publisher),
        retracted: r.retracted === true,
        editorialNotices: toEditorialNotices(r.editorialNotices),
        // doi.org rather than a scite.ai/reports/{slug} link: the resolver URL
        // is correct for every DOI, whereas the slug is Scite-internal and
        // dead for anyone without a Scite seat.
        url: `https://doi.org/${doi}`,
      });
    }
  }
  return out;
}

/**
 * The function the research engine actually needs: given DOIs discovered by
 * the web-research phase, attach Scite's citation evidence.
 *
 * Papers Scite has never indexed are dropped rather than returned with zeroed
 * tallies — an unindexed paper and a paper with no citations are different
 * claims, and only the second one is evidence.
 */
export async function enrichDoisWithScite(
  dois: string[],
  env: SciteEnv
): Promise<ScitePaper[]> {
  const unique = [...new Set(dois.map((d) => d.toLowerCase()))];
  if (unique.length === 0 || !env.SCITE_API_KEY) return [];

  const [papers, tallies] = await Promise.all([
    getScitePapers(unique, env),
    getSciteTalliesBatch(unique, env),
  ]);

  const out: ScitePaper[] = [];
  for (const [doi, paper] of papers) {
    out.push({ ...paper, citations: tallies.get(doi) ?? ZERO_CITATIONS });
  }

  // Retracted first — a retracted paper is the single most important thing
  // this integration can tell the pipeline, and it must not be buried under
  // whatever is most cited. Otherwise most-supported first.
  return out.sort((a, b) => {
    if (a.retracted !== b.retracted) return a.retracted ? -1 : 1;
    return b.citations.supporting - a.citations.supporting;
  });
}

export interface CitationAssessment {
  /** Papers whose citations lean supporting. */
  supporting: ScitePaper[];
  /** Papers whose citations lean contradicting. */
  contradicting: ScitePaper[];
  /** Papers Scite flags as retracted or carrying an editorial notice. */
  flagged: ScitePaper[];
  /**
   * Supporting share of *classified* citations, or null when nothing was
   * classified. Null rather than 0: "no evidence either way" and "the
   * literature contradicts this" must not collapse to the same number.
   */
  confidence: number | null;
}

/**
 * Local classification over already-fetched papers. No network call — the
 * endpoint that used to do this server-side (`POST /reference_check`) is
 * partner-tier and returns 403 on this account.
 *
 * Only supporting and contradicting citations count toward confidence.
 * `mentioning` dominates real tallies (44,825 of 45,561 for one paper
 * measured on 2026-08-25) and says nothing about agreement, so including it
 * would drive every confidence score toward zero regardless of the evidence.
 */
export function assessCitationSupport(
  papers: ScitePaper[]
): CitationAssessment {
  const supporting = papers
    .filter((p) => p.citations.supporting > p.citations.contradicting)
    .sort((a, b) => b.citations.supporting - a.citations.supporting);

  const contradicting = papers
    .filter((p) => p.citations.contradicting > p.citations.supporting)
    .sort((a, b) => b.citations.contradicting - a.citations.contradicting);

  const flagged = papers.filter(
    (p) => p.retracted || p.editorialNotices.length > 0
  );

  let sup = 0;
  let con = 0;
  for (const p of papers) {
    sup += p.citations.supporting;
    con += p.citations.contradicting;
  }
  const classified = sup + con;

  return {
    supporting,
    contradicting,
    flagged,
    confidence: classified > 0 ? sup / classified : null,
  };
}

/**
 * Research Engine — the "discovery" in dis[cover]co[here][i]mplemented.
 *
 * This is the research stage of the Discomplement pipeline. Instead of
 * generating code from scratch, it:
 *
 * 1. Searches You.com Research API for real-time web intelligence + citations
 * 2. Searches Scite for peer-reviewed research (Smart Citations)
 * 3. Searches GitHub for existing open source code to reuse
 * 4. Uses Cohere rerank to rank the most relevant findings
 * 5. Uses Cohere embed to create semantic representations for the lattice
 * 6. Returns research findings, reusable code, and citation-backed context
 *
 * The research-audit-implement-audit loop:
 *   Research: gather sources (You.com + Scite + GitHub)
 *   Audit:    verify findings with Cohere rerank + Scite citation context
 *   Implement: use the audited findings to generate or adapt code
 *   Audit:    verify the implementation matches the research
 *   Loop until quality gates pass
 *
 * This is what makes Discomplement different from Replit — it doesn't
 * just generate code, it does research-backed, audited, governed
 * code generation with value assurance.
 */

import {
  extractDois,
  enrichDoisWithScite,
  assessCitationSupport,
  type ScitePaper,
} from './scite-research.js';
import {
  searchGitHubCode,
  fetchGitHubFileContent,
  findReusableComponents,
  type GitHubCodeResult,
} from './github-code-search.js';
import { embed, rerank, ingest, type LatticeDoc } from './cohere-lattice.js';
import {
  youComResearch,
  youComSearch,
  youComAnswer,
  type YouComResearchResult,
  type YouComSearchResult,
} from './youcom-research.js';
import {
  tavilySearch,
  tavilySearchScholarly,
  tavilyCorpus,
} from './tavily-research.js';

export interface ResearchFinding {
  type: 'web' | 'paper' | 'code';
  title: string;
  description: string;
  url: string;
  relevance: number;
  source: 'youcom' | 'tavily' | 'scite' | 'github';
  citationContext?: {
    supporting: number;
    /**
     * Scite's own field name. This was `contrasting` and read a field Scite
     * does not return, so it was always 0 — see lib/scite-research.ts.
     */
    contradicting: number;
    /** Null when no citation was classified either way. Never coerce to 0. */
    confidence: number | null;
    retracted?: boolean;
  };
  codeContent?: string;
  repo?: string;
  license?: string;
  stars?: number;
  snippets?: string[];
  pageAge?: string | null;
}

export interface ResearchResult {
  findings: ResearchFinding[];
  recommendedApproach: string;
  reusableCode: Array<{ path: string; content: string; source: string }>;
  citationContext: {
    supporting: number;
    contradicting: number;
    /** Null when the literature classified nothing either way. */
    confidence: number | null;
    /** DOIs Scite flags as retracted or carrying an editorial notice. */
    retracted: string[];
    youComAnswer?: string;
  };
  latticeDocs: LatticeDoc[];
  rawResearch?: YouComResearchResult;
}

export interface ResearchEnv {
  COHERE_API_KEY: string;
  GITHUB_TOKEN: string;
  // Optional: unset in production, and the Scite phase degrades to "no
  // citation evidence" rather than failing. Declaring it `string` forced
  // callers to coerce with `?? ''`, which is indistinguishable from a real
  // key at the type level and sent an empty bearer to a third party.
  SCITE_API_KEY?: string;
  /** Optional for the same reason as SCITE_API_KEY — phase 1b degrades. */
  TAVILY_API_KEY?: string;
  YDC_API_KEY: string;
}

/**
 * Run the full research stage for a user's prompt.
 *
 * @param prompt — the user's original prompt (e.g., "Build a todo app")
 * @param env — API keys for You.com, Scite, GitHub, and Cohere
 * @returns research findings, reusable code, and lattice documents
 */
export async function runResearch(
  prompt: string,
  env: ResearchEnv
): Promise<ResearchResult> {
  const findings: ResearchFinding[] = [];
  const latticeDocs: LatticeDoc[] = [];
  let youComAnswerText: string | undefined;

  // --- Phase 1: You.com Research (real-time web intelligence) ---
  try {
    // Run the deep research API for complex, multi-step research
    const research = await youComResearch(prompt, env, {
      researchEffort: 'standard',
      outputFormat: 'markdown',
    });

    youComAnswerText = research.output.content;

    // Add research sources as findings
    for (const source of research.output.sources) {
      findings.push({
        type: 'web',
        title: source.title ?? 'Untitled',
        description: source.snippets?.join(' ').slice(0, 300) ?? '',
        url: source.url,
        relevance: 0.6, // Will be reranked
        source: 'youcom',
        snippets: source.snippets,
      });
    }

    // Ingest the research answer into the Intent space of the lattice
    if (research.output.content) {
      const doc = await ingest(
        {
          id: `youcom-research-${Date.now()}`,
          space: 'intent',
          text: research.output.content,
          metadata: {
            source: 'youcom',
            uuid: research.metadata?.research_uuid,
            latency: research.metadata?.latency,
          },
        },
        env
      );
      latticeDocs.push(doc);
    }

    // Also run a quick web search for code-specific results
    const codeSearchQuery = `${prompt} implementation example code`;
    const webResults = await youComSearch(codeSearchQuery, env, {
      count: 10,
      extractionMode: 'none',
    });

    for (const result of webResults.results) {
      findings.push({
        type: 'web',
        title: result.title,
        description: result.description,
        url: result.url,
        relevance: 0.4,
        source: 'youcom',
        snippets: result.snippets,
        pageAge: result.page_age,
      });
    }
  } catch (err) {
    console.warn('You.com research failed (non-blocking):', err);
  }

  // --- Phase 1b: Tavily (second search backend + DOI feeder for Scite) ---
  //
  // Two calls, doing two different jobs.
  //
  // The first is an ordinary web search — a second opinion alongside
  // You.com, arbitrated by the same Cohere rerank in phase 4, so a weak
  // Tavily result sinks on its own rather than needing a rule here.
  //
  // The second is domain-scoped to publishers that print DOIs, and exists
  // purely to feed phase 2. Scite cannot search on this account, so its
  // citation and retraction signal is only ever as good as the DOIs handed
  // to it. Measured: an unscoped search over the same query yielded zero
  // DOIs; the scoped one yielded DOIs. Without this, phase 2 depends on
  // whatever DOIs You.com happened to mention.
  //
  // Budget: the plan is 1,500 credits/month and the scholarly pass uses
  // `advanced` depth, which costs more per call. Two calls per research
  // run is a real cost — hence exactly two, not one per finding.
  let tavilyCorpusText = '';

  try {
    const [general, scholarly] = await Promise.all([
      tavilySearch(prompt, env, {
        maxResults: 10,
        includeAnswer: 'basic',
      }),
      tavilySearchScholarly(prompt, env),
    ]);

    for (const r of general.results) {
      findings.push({
        type: 'web',
        title: r.title,
        description: r.content.slice(0, 300),
        url: r.url,
        // Tavily's own 0–1 score. Phase 4 overwrites this with Cohere's,
        // which is the only score compared across sources — the two are
        // not on a common scale, so this is a starting order, not a rank.
        relevance: r.score,
        source: 'tavily',
      });
    }

    // Scholarly hits are kept as findings too, not just mined for DOIs:
    // a primary source that phase 2 cannot resolve to a Scite record is
    // still a better citation than a blog post about it.
    for (const r of scholarly.results) {
      findings.push({
        type: 'paper',
        title: r.title,
        description: r.content.slice(0, 300),
        url: r.url,
        relevance: r.score,
        source: 'tavily',
      });
    }

    tavilyCorpusText = `${tavilyCorpus(general)}\n${tavilyCorpus(scholarly)}`;

    if (general.results.length || scholarly.results.length) {
      console.log(
        `Tavily: ${general.results.length} web + ${scholarly.results.length} scholarly result(s)`
      );
    }
  } catch (err) {
    console.warn('Tavily research failed (non-blocking):', err);
  }

  // --- Phase 2: Scite (citation evidence for what phase 1 already found) ---
  //
  // This phase used to call `searchScite(prompt)` — a text search against
  // `POST /search`, an endpoint that returns 404 because it does not exist.
  // The real search endpoint is partner-tier and 403s on this account, so
  // Scite cannot *find* papers for us at all. What it can do, and does well,
  // is answer questions about DOIs we already have.
  //
  // So the DOIs come from phase 1: web results and their snippets routinely
  // carry them, either bare or inside a doi.org URL. Scite then supplies the
  // citation tallies and — the part that matters most — the retraction flag.
  let citationConfidence: number | null = null;
  let retractedDois: string[] = [];

  try {
    const doiCorpus = findings
      .map(
        (f) =>
          `${f.url} ${f.title} ${f.description} ${f.snippets?.join(' ') ?? ''}`
      )
      .join('\n');
    // Tavily's scholarly pass is the highest-yield source here — its raw
    // page text carries DOIs that the trimmed snippets in `findings` drop.
    const dois = extractDois(
      `${doiCorpus}\n${youComAnswerText ?? ''}\n${tavilyCorpusText}`
    );

    const scitePapers = await enrichDoisWithScite(dois, env);
    const assessment = assessCitationSupport(scitePapers);
    citationConfidence = assessment.confidence;
    retractedDois = assessment.flagged.map((p) => p.doi);

    if (dois.length > 0) {
      console.log(
        `Scite: ${dois.length} DOI(s) extracted from web research, ${scitePapers.length} indexed, ${assessment.flagged.length} flagged`
      );
    }

    for (const paper of scitePapers) {
      findings.push({
        type: 'paper',
        title: paper.title,
        description: paper.abstract.slice(0, 300),
        url: paper.url,
        // A flagged paper outranks everything: the pipeline needs to see it
        // even if it is the least-cited thing in the set.
        relevance: paper.retracted ? 0.95 : 0.5,
        source: 'scite',
        citationContext: {
          supporting: paper.citations.supporting,
          contradicting: paper.citations.contradicting,
          confidence:
            paper.citations.supporting + paper.citations.contradicting > 0
              ? paper.citations.supporting /
                (paper.citations.supporting + paper.citations.contradicting)
              : null,
          retracted: paper.retracted,
        },
      });
    }

    // Ingest papers into the Intent space
    for (const paper of scitePapers) {
      const doc = await ingest(
        {
          id: `paper-${paper.doi}`,
          space: 'intent',
          text: `${paper.title}. ${paper.abstract}`,
          metadata: {
            doi: paper.doi,
            journal: paper.journal,
            year: paper.year,
            citations: paper.citations.total,
            retracted: paper.retracted,
          },
        },
        env
      );
      latticeDocs.push(doc);
    }
  } catch (err) {
    console.warn('Scite research failed (non-blocking):', err);
  }

  // --- Phase 3: GitHub Code Search (existing open source code) ---
  let githubResults: GitHubCodeResult[] = [];
  const reusableCode: Array<{ path: string; content: string; source: string }> =
    [];

  try {
    githubResults = await findReusableComponents(prompt, env);

    for (const result of githubResults) {
      findings.push({
        type: 'code',
        title: result.path,
        description:
          result.repository.description ?? `Code from ${result.repo}`,
        url: result.html_url,
        relevance: 0.5,
        source: 'github',
        repo: result.repository.full_name,
        license: result.repository.license || undefined,
        stars: result.repository.stars,
      });
    }

    // Fetch the actual code content for the top 5 results
    for (const result of githubResults.slice(0, 5)) {
      try {
        const [repo] = result.repo.split('@');
        const content = await fetchGitHubFileContent(
          repo || result.repo,
          result.path,
          'main',
          env
        );
        reusableCode.push({
          path: result.path,
          content,
          source: result.repo,
        });

        // Ingest code into the Code space of the lattice
        const doc = await ingest(
          {
            id: `code-${result.repo}-${result.path}`,
            space: 'code',
            text: content.slice(0, 4000),
            metadata: {
              repo: result.repo,
              path: result.path,
              license: result.repository.license || undefined,
              stars: result.repository.stars,
            },
          },
          env
        );
        latticeDocs.push(doc);
      } catch {
        // Non-blocking
      }
    }
  } catch (err) {
    console.warn('GitHub code search failed (non-blocking):', err);
  }

  // --- Phase 4: Cohere Rerank (audit the findings) ---
  try {
    if (findings.length > 0) {
      const findingTexts = findings.map(
        (f) => `${f.title} ${f.description} ${f.snippets?.join(' ') ?? ''}`
      );

      const rerankResults = await rerank(
        prompt,
        findingTexts,
        Math.min(15, findings.length),
        env
      );

      for (const r of rerankResults) {
        if (findings[r.index]) {
          findings[r.index].relevance = r.relevance_score;
        }
      }

      findings.sort((a, b) => b.relevance - a.relevance);
    }
  } catch (err) {
    console.warn('Cohere rerank failed (non-blocking):', err);
  }

  // --- Phase 5: Synthesize recommended approach ---
  const topPapers = findings.filter((f) => f.type === 'paper').slice(0, 5);
  const topCode = findings.filter((f) => f.type === 'code').slice(0, 5);
  const topWeb = findings.filter((f) => f.type === 'web').slice(0, 5);

  const recommendedApproach = synthesizeApproach(
    prompt,
    topWeb,
    topPapers,
    topCode,
    citationConfidence,
    youComAnswerText
  );

  return {
    findings,
    recommendedApproach,
    reusableCode,
    citationContext: {
      supporting: topPapers.reduce(
        (s, p) => s + (p.citationContext?.supporting ?? 0),
        0
      ),
      contradicting: topPapers.reduce(
        (s, p) => s + (p.citationContext?.contradicting ?? 0),
        0
      ),
      confidence: citationConfidence,
      retracted: retractedDois,
      youComAnswer: youComAnswerText,
    },
    latticeDocs,
  };
}

/**
 * Synthesize a recommended approach from the research findings.
 * This becomes the input to the researcher step.
 */
function synthesizeApproach(
  prompt: string,
  web: ResearchFinding[],
  papers: ResearchFinding[],
  code: ResearchFinding[],
  confidence: number | null,
  youComAnswer?: string
): string {
  const parts: string[] = [];

  parts.push(`# Research Summary for: "${prompt}"`);
  parts.push('');
  // Report what Scite actually classified rather than a derived percentage.
  // `confidence` is null when no citation was classified either way, and
  // rendering that as "0%" would assert the literature disputes the work
  // when in fact it has said nothing about it.
  parts.push(
    confidence === null
      ? '## Citation evidence: none classified (Scite indexed no supporting or contradicting citation for these DOIs)'
      : `## Citation evidence: ${(confidence * 100).toFixed(0)}% of classified citations are supporting`
  );
  parts.push('');

  if (youComAnswer) {
    parts.push('## You.com Research Answer');
    parts.push(youComAnswer.slice(0, 2000));
    parts.push('');
  }

  if (web.length > 0) {
    parts.push('## Web Intelligence (You.com)');
    for (const w of web) {
      parts.push(`- ${w.title}`);
      parts.push(`  - ${w.url}`);
      if (w.snippets?.length) parts.push(`  - ${w.snippets[0]!.slice(0, 200)}`);
    }
    parts.push('');
  }

  if (papers.length > 0) {
    parts.push('## Peer-Reviewed Research (Scite)');
    for (const paper of papers) {
      parts.push(`- ${paper.title}`);
      // Say "not classified" rather than printing 0 — a null confidence
      // means Scite classified no citation either way, which is not the
      // same claim as "zero papers support this".
      if (paper.citationContext?.retracted) {
        parts.push('  - **RETRACTED or flagged by an editorial notice**');
      }
      parts.push(
        `  - Supporting: ${paper.citationContext?.supporting ?? 0}, Contradicting: ${paper.citationContext?.contradicting ?? 0}`
      );
    }
    parts.push('');
  }

  if (code.length > 0) {
    parts.push('## Reusable Open Source Code (GitHub)');
    for (const c of code) {
      parts.push(
        `- ${c.repo}/${c.title} (${c.license ?? 'unknown license'}, ${c.stars ?? 0} stars)`
      );
      parts.push(`  - ${c.url}`);
    }
    parts.push('');
  }

  if (code.length > 0) {
    parts.push('## Recommendation');
    parts.push(
      `Instead of generating code from scratch, consider adapting the ${code.length} open source implementation(s) found above.`
    );
    parts.push(
      'This saves credits, improves quality, and leverages battle-tested code.'
    );
  } else {
    parts.push('## Recommendation');
    parts.push(
      'No directly reusable open source code found. Generate from scratch using the research findings as context.'
    );
  }

  return parts.join('\n');
}

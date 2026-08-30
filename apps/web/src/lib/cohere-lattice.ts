/**
 * Cohere Memory Lattice — the semantic positioning space for Discomplement.
 *
 * Uses Cohere embed v4.0 (1536 dims — matches Vectorize index) with input_type-aware
 * embedding and rerank-v4.0-pro for retrieval. Four co-embedded spaces:
 *   1. Intent — user prompts, approvals, rejections, corrections
 *   2. Code — per-file chunks with path + docstring
 *   3. Design dialectic — thesis + antithesis for each decision
 *   4. Outcome — runtime events: passed/failed/errors/abandonment
 *
 * This is the "co" in dis[cover]co[here][i]mplemented — the coherent memory
 * that makes the agents' research-backed, audited, governed generation possible.
 *
 * Storage: D1 with vector columns (simulated via JSON arrays for now, will
 * migrate to pgvector when moving to Postgres substrate).
 */

export interface LatticeDoc {
  id: string;
  space: 'intent' | 'code' | 'dialectic' | 'outcome';
  text: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

export interface RetrievalResult {
  doc: LatticeDoc;
  score: number;
}

const COHERE_API_BASE = 'https://api.cohere.com/v2';

/**
 * Embed text using Cohere embed v4.
 * Uses input_type parameter for task-aware embedding.
 */
export async function embed(
  texts: string | string[],
  inputType:
    | 'search_document'
    | 'search_query'
    | 'classification'
    | 'clustering',
  env: { COHERE_API_KEY: string }
): Promise<number[][]> {
  const textArray = Array.isArray(texts) ? texts : [texts];

  const response = await fetch('https://api.cohere.com/v2/embed', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.COHERE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'embed-v4.0',
      texts: textArray,
      input_type: inputType,
      embedding_types: ['float'],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cohere embed failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    embeddings: { float: number[][] };
  };

  return data.embeddings.float;
}

/**
 * Rerank documents using Cohere rerank-v3.5.
 * Takes a query and a list of documents, returns them sorted by relevance.
 */
export async function rerank(
  query: string,
  documents: string[],
  topN: number = 12,
  env: { COHERE_API_KEY: string }
): Promise<{ index: number; relevance_score: number }[]> {
  const response = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.COHERE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'rerank-v4.0-pro',
      query,
      documents,
      top_n: topN,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cohere rerank failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    results: { index: number; relevance_score: number }[];
  };

  return data.results;
}

/**
 * Full retrieval contract: embed query → fan out → rerank → top-k.
 * This is called before every agent step to provide context.
 *
 * Budget: ≤ 8k tokens of retrieved context per agent step.
 */
export async function retrieve(
  query: string,
  docs: LatticeDoc[],
  env: { COHERE_API_KEY: string },
  topK: number = 12
): Promise<RetrievalResult[]> {
  // Step 1: Embed the query
  const queryEmbedding = await embed(query, 'search_query', env);

  // Step 2: Fan out — compute cosine similarity against all docs
  const scored = docs.map((doc, index) => {
    if (!doc.embedding) return { doc, score: 0, index };
    const similarity = cosineSimilarity(queryEmbedding[0], doc.embedding);
    return { doc, score: similarity, index };
  });

  // Sort by similarity, take top 60 for reranking
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, Math.min(60, scored.length));

  // Step 3: Rerank with Cohere rerank-v3.5
  const candidateTexts = candidates.map((c) => c.doc.text);
  if (candidateTexts.length === 0) return [];

  const rerankResults = await rerank(query, candidateTexts, topK, env);

  // Step 4: Return top-k with rerank scores
  return rerankResults.map((r) => ({
    doc: candidates[r.index].doc,
    score: r.relevance_score,
  }));
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embed and store a document in the lattice.
 * Returns the document with its embedding.
 */
export async function ingest(
  doc: Omit<LatticeDoc, 'embedding'>,
  env: { COHERE_API_KEY: string }
): Promise<LatticeDoc> {
  const inputType = doc.space === 'outcome' ? 'clustering' : 'search_document';
  const embeddings = await embed(
    doc.text,
    inputType as 'search_document' | 'clustering',
    env
  );
  return { ...doc, embedding: embeddings[0] };
}

/**
 * Create a decision record with thesis + antithesis embeddings.
 * This is the dialectic mechanic from the blueprint (§3.2).
 */
export async function createDecision(
  thesis: string,
  antithesis: string,
  axisLabel: string,
  chosen: 'thesis' | 'antithesis',
  rationale: string,
  env: { COHERE_API_KEY: string }
): Promise<{
  id: string;
  thesis: string;
  antithesis: string;
  axis_label: string;
  chosen: 'thesis' | 'antithesis';
  rationale: string;
  embeddings: { thesis: number[]; antithesis: number[] };
  axis: number[];
}> {
  const [thesisEmb, antithesisEmb] = await embed(
    [thesis, antithesis],
    'search_document',
    env
  );

  // The axis is normalize(E(thesis) - E(antithesis))
  const axis = thesisEmb.map((val, i) => val - antithesisEmb[i]);
  const norm = Math.sqrt(axis.reduce((sum, v) => sum + v * v, 0));
  const normalizedAxis = norm > 0 ? axis.map((v) => v / norm) : axis;

  return {
    id: `dec_${Date.now()}`,
    thesis,
    antithesis,
    axis_label: axisLabel,
    chosen,
    rationale,
    embeddings: { thesis: thesisEmb, antithesis: antithesisEmb },
    axis: normalizedAxis,
  };
}

/**
 * Project an artifact onto a decision axis.
 * Returns the projection value: positive = aligned with thesis, negative = aligned with antithesis.
 * If the projection is opposite to the user's chosen position, it's drift.
 */
export function projectOnAxis(
  artifactEmbedding: number[],
  axis: number[]
): number {
  return cosineSimilarity(artifactEmbedding, axis);
}

/**
 * Check for architectural drift: if new code projects opposite to the
 * user's chosen position on a decision axis, flag it.
 */
export function detectDrift(
  codeEmbedding: number[],
  decisions: Array<{
    axis: number[];
    chosen: 'thesis' | 'antithesis';
    axis_label: string;
  }>,
  threshold: number = -0.3
): Array<{ axis_label: string; projection: number; drift: boolean }> {
  return decisions.map((dec) => {
    const projection = projectOnAxis(codeEmbedding, dec.axis);
    // If chosen was thesis (+) but projection is negative, that's drift
    // If chosen was antithesis (-) but projection is positive, that's drift
    const drift =
      (dec.chosen === 'thesis' && projection < threshold) ||
      (dec.chosen === 'antithesis' && projection > -threshold);
    return { axis_label: dec.axis_label, projection, drift };
  });
}

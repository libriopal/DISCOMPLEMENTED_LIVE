/**
 * @bicameral/cohere/rerank — Cohere Rerank v4
 * Re-orders candidate documents by relevance to a query
 */
import { cohereRequestJson, type CohereEnv, type CohereResponse } from './index.js';

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  topN: number;
  returnDocuments?: boolean;
  maxChunksPerDoc?: number;
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
  document?: { text: string };
}

export interface RerankResponse {
  id: string;
  results: RerankResult[];
  meta: {
    billedTokens: { inputTokens: number; outputTokens: number };
    warnings?: string[];
  };
}

export async function rerank(
  request: RerankRequest,
  env: CohereEnv
): Promise<CohereResponse<RerankResponse>> {
  const body = {
    model: request.model,
    query: request.query,
    documents: request.documents,
    top_n: request.topN,
    ...(request.returnDocuments !== undefined && { return_documents: request.returnDocuments }),
    ...(request.maxChunksPerDoc && { max_chunks_per_doc: request.maxChunksPerDoc }),
  };

  const response = await cohereRequestJson<RerankResponse>('rerank', body, env);
  return {
    ...response,
    cost: {
      inputTokens: response.data.meta.billedTokens.inputTokens,
      outputTokens: response.data.meta.billedTokens.outputTokens,
      billedTokens: response.data.meta.billedTokens.inputTokens + response.data.meta.billedTokens.outputTokens,
    },
  };
}

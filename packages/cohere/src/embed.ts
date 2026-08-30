/**
 * @bicameral/cohere/embed — Embeddings via Cohere Embed v4
 * input_type=search_query for queries, input_type=search_document for indexing
 */
import {
  cohereRequestJson,
  type CohereEnv,
  type CohereResponse,
} from './index.js';

export interface EmbedRequest {
  model: string;
  texts: string[];
  inputType:
    | 'search_query'
    | 'search_document'
    | 'classification'
    | 'clustering';
  embeddingTypes?:
    | ['float']
    | ['int8']
    | ['binary']
    | ['int8', 'uint8']
    | ['float', 'int8'];
  truncate?: 'none' | 'end' | 'start';
  // Simulation-evolved: 1536 dimensions (Butterfly v7)
  // Cohere Embed v4 supports up to 1536 dimensions
  dimensions?: number;
}

export interface EmbedResponse {
  id: string;
  embeddings: {
    float?: number[][];
    int8?: number[][];
    binary?: number[][];
  };
  meta: {
    billedTokens: { inputTokens: number };
    warnings?: string[];
  };
}

// Cohere's actual v2 /embed response — verified directly against the live
// API. `meta.billed_units` is snake_case and nested, and there is no
// output-token count at all for embeddings (nothing is "generated").
// The previous shape (`meta.billedTokens.inputTokens/outputTokens`) never
// matched a real response, so every `embed()` call threw a TypeError on
// `.inputTokens` of `undefined` before it could return — see chat.ts for
// the same defect class, already fixed there.
interface CohereRawEmbedResponse {
  id: string;
  embeddings: {
    float?: number[][];
    int8?: number[][];
    binary?: number[][];
  };
  meta?: {
    billed_units?: { input_tokens?: number };
    warnings?: string[];
  };
}

export async function embed(
  request: EmbedRequest,
  env: CohereEnv
): Promise<CohereResponse<EmbedResponse>> {
  const body = {
    model: request.model,
    texts: request.texts,
    input_type: request.inputType,
    ...(request.embeddingTypes && { embedding_types: request.embeddingTypes }),
    ...(request.truncate && { truncate: request.truncate }),
    ...(request.dimensions && { dimensions: request.dimensions }),
  };

  const response = await cohereRequestJson<CohereRawEmbedResponse>(
    'embed',
    body,
    env
  );
  const inputTokens = response.data.meta?.billed_units?.input_tokens ?? 0;
  const data: EmbedResponse = {
    id: response.data.id,
    embeddings: response.data.embeddings,
    meta: {
      billedTokens: { inputTokens },
      warnings: response.data.meta?.warnings,
    },
  };

  return {
    ...response,
    data,
    cost: {
      inputTokens,
      outputTokens: 0,
      billedTokens: inputTokens,
    },
  };
}

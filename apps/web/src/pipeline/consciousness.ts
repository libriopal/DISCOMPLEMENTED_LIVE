/**
 * ConsciousnessLayer — Short-term memory for the current conversation/pipeline run.
 *
 * This is the "consciousness" — the awareness of what's happening RIGHT NOW.
 * It bridges:
 *   Subconscious (long-term cloud memory) ←→ Conscious (current conversation)
 *
 * Architecture:
 *   1. Each message/thought in the current pipeline run is embedded via Embed v4
 *   2. These embeddings form a TEMPORARY cluster in the geometric cloud
 *   3. As the pipeline progresses, the cluster grows and becomes denser
 *   4. The agent's "awareness" = the condensed view of this temporary cluster
 *   5. When the pipeline completes, the cluster is evaluated:
 *      - High-value insights → promoted to permanent cloud (long-term memory)
 *      - Routine exchanges → compressed into semantic poetry and stored
 *      - Wasted credits → discarded (pruning, like synaptic pruning in sleep)
 *
 * The consciousness layer manages the context window:
 *   - Full conversation history would blow the context window (128K-256K tokens)
 *   - Instead, we compress earlier messages into "semantic poetry" — short,
 *     dense, semantically rich expressions that capture the essence
 *   - The agent sees: recent messages (full) + compressed older messages (poetry)
 *   - This is like how humans remember the gist of early conversation
 *     but the exact words of recent exchanges
 *
 * Semantic Poetry — deterministic compression:
 *   - North Mini Code (reasoning disabled) compresses conversation blocks
 *   - Each block of N messages → 2-4 lines of semantic poetry
 *   - The poetry preserves: key decisions, errors, patterns, outcomes
 *   - Deterministic: same input → similar poetry (not exact, but consistent)
 *
 * The poetry is stored as a "condensed thought" — a single embedding that
 * represents the entire conversation block. When an agent needs to recall
 * the full context, it can "expand" the poetry back into a detailed summary
 * using Command A+ with reasoning enabled.
 *
 * Connection to the geometric cloud:
 *   - The consciousness cluster has a seed derived from the pipeline run ID
 *   - This seed places the cluster in a specific region of the geometric cloud
 *   - The subconscious cloud provides long-term context (past patterns)
 *   - The consciousness cluster provides short-term context (current conversation)
 *   - The bridge: the consciousness cluster's centroid (average embedding) is
 *     used as a query to find related patterns in the subconscious cloud
 */
import { embed } from '@bicameral/cohere/embed';
import { chat } from '@bicameral/cohere/chat';
import { COHERE_MODELS } from '@bicameral/shared/constants';
import type { Env } from '../env.js';

/** A single message in the consciousness layer */
export interface ConsciousMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thinking';
  content: string;
  timestamp: number;
  /** The embedding of this message (computed lazily) */
  embedding?: number[];
  /** Whether this message has been compressed into poetry */
  compressed: boolean;
}

/** A compressed block of messages — semantic poetry */
export interface CompressedBlock {
  /** The poetry — short, dense semantic expression */
  poetry: string;
  /** The embedding of the poetry (used for cloud queries) */
  embedding: number[];
  /** How many messages were compressed */
  messageCount: number;
  /** Which agent produced these messages */
  agentRole: string;
  /** When this block was compressed */
  compressedAt: number;
}

/** The consciousness layer for a single pipeline run */
export interface ConsciousnessState {
  pipelineRunId: string;
  projectId: string | null;
  /** All messages in the current pipeline run */
  messages: ConsciousMessage[];
  /** Compressed blocks (semantic poetry) */
  compressedBlocks: CompressedBlock[];
  /** The seed for this consciousness cluster */
  seed: string;
  /** Whether reasoning/thinking is active (affects compression strategy) */
  reasoningActive: boolean;
  /** Total tokens in uncompressed messages */
  totalTokens: number;
  /** Max tokens before compression kicks in */
  compressionThreshold: number;
}

/** Configuration for the consciousness layer */
export const CONSCIOUSNESS_CONFIG = {
  /** Compress when raw messages exceed this token count */
  compressionThreshold: 8000,
  /** How many messages to compress per block */
  messagesPerBlock: 10,
  /** Max tokens for North Mini Code compression */
  compressionMaxTokens: 200,
  /** How many recent messages to keep uncompressed (the "working memory") */
  workingMemorySize: 5,
};

const COMPRESSION_SYSTEM = `You are a semantic compression engine. Your job is to compress a block of conversation into dense, poetic lines that capture the ESSENCE — key decisions, errors, patterns, and outcomes. 

Rules:
- Output 2-4 lines of semantic poetry only — no prose, no explanations
- Preserve: key decisions, errors found, patterns identified, outcomes
- Be dense — every word carries meaning
- Be deterministic — similar inputs should produce similar poetry
- Use the language of the domain (code terms, architecture terms, etc.)

Example input: "The researcher found that React+SQLite is good for todo apps. The auditor flagged missing security considerations. The verifier confirmed the dependencies are real."
Example output: "React+SQLite chosen for todos / security gaps flagged by auditor / dependencies verified as real"`;

/**
 * Create a new consciousness state for a pipeline run.
 * The seed is derived from the pipeline run ID + project ID,
 * placing the consciousness cluster in a deterministic region of the cloud.
 */
export function createConsciousness(
  pipelineRunId: string,
  projectId: string | null,
  reasoningActive: boolean = false
): ConsciousnessState {
  const seed = `${projectId ?? 'global'}:${pipelineRunId}`;
  return {
    pipelineRunId,
    projectId,
    messages: [],
    compressedBlocks: [],
    seed,
    reasoningActive,
    totalTokens: 0,
    compressionThreshold: CONSCIOUSNESS_CONFIG.compressionThreshold,
  };
}

/**
 * Add a message to the consciousness layer.
 * If the total tokens exceed the compression threshold, older messages
 * are compressed into semantic poetry automatically.
 */
export async function addMessage(
  state: ConsciousnessState,
  message: Omit<ConsciousMessage, 'id' | 'timestamp' | 'compressed'>,
  env: Env
): Promise<ConsciousnessState> {
  const id = crypto.randomUUID();
  const msg: ConsciousMessage = {
    ...message,
    id,
    timestamp: Date.now(),
    compressed: false,
  };

  // Rough token estimate (4 chars ≈ 1 token)
  const tokenEstimate = Math.ceil(message.content.length / 4);
  state.messages.push(msg);
  state.totalTokens += tokenEstimate;

  // Compress if we've exceeded the threshold
  if (state.totalTokens > state.compressionThreshold) {
    await compressOldMessages(state, env);
  }

  return state;
}

/**
 * Compress older messages into semantic poetry.
 * Keeps the most recent N messages (working memory) uncompressed.
 * Everything older is compressed into blocks and replaced with poetry.
 */
async function compressOldMessages(
  state: ConsciousnessState,
  env: Env
): Promise<void> {
  const keepCount = CONSCIOUSNESS_CONFIG.workingMemorySize;
  const messagesToCompress = state.messages.filter((m) => !m.compressed);

  if (messagesToCompress.length <= keepCount) return;

  // Take the oldest un-compressed messages (beyond working memory)
  const toCompress = messagesToCompress.slice(0, -keepCount);

  // Group into blocks
  const blockSize = CONSCIOUSNESS_CONFIG.messagesPerBlock;
  for (let i = 0; i < toCompress.length; i += blockSize) {
    const block = toCompress.slice(i, i + blockSize);
    const blockContent = block
      .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
      .join('\n');

    try {
      // Compress via North Mini Code (reasoning disabled — it only works that way)
      const response = await Promise.race([
        chat(
          {
            model: 'north-mini-code-1-0',
            messages: [
              { role: 'system', content: COMPRESSION_SYSTEM },
              {
                role: 'user',
                content: `Compress this conversation block:\n${blockContent}`,
              },
            ],
            maxTokens: CONSCIOUSNESS_CONFIG.compressionMaxTokens,
            temperature: 0.2, // Low temp for consistency
            // Kept as intent; chat() drops the field before it reaches the
            // wire, because north-mini-code-1-0 is not a reasoning model and
            // answers a request carrying `thinking` with a 422.
            thinking: { type: 'disabled' },
          },
          {
            COHERE_API_KEY: env.COHERE_API_KEY,
            COHERE_API_BASE: env.COHERE_BASE_URL,
          }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('compression-timeout-5s')), 5000)
        ),
      ]);
      const rawContent: unknown = response.data?.message?.content;
      const poetry: string =
        typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? (rawContent as Array<{ type: string; text: string }>)
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('')
            : '';
      if (!poetry) continue;

      // Embed the poetry for cloud queries
      const embeddingResponse = await embed(
        {
          model: COHERE_MODELS.embed,
          texts: [poetry],
          inputType: 'search_document',
        },
        {
          COHERE_API_KEY: env.COHERE_API_KEY,
          COHERE_API_BASE: env.COHERE_BASE_URL,
        }
      );
      const embedding = embeddingResponse.data.embeddings.float?.[0];
      if (!embedding) continue;

      const compressedBlock: CompressedBlock = {
        poetry,
        embedding,
        messageCount: block.length,
        agentRole: block[0]?.role ?? 'unknown',
        compressedAt: Date.now(),
      };

      state.compressedBlocks.push(compressedBlock);

      // Mark messages as compressed and remove their content from memory
      // (the poetry + embedding preserves the semantic meaning)
      for (const msg of block) {
        msg.compressed = true;
        // Keep a short reference, remove full content
        msg.content = `[compressed: ${poetry.slice(0, 50)}...]`;
      }

      // Recalculate total tokens
      state.totalTokens = state.messages.reduce((sum, m) => {
        if (m.compressed) return sum + Math.ceil(m.content.length / 4);
        return sum + Math.ceil(m.content.length / 4);
      }, 0);
    } catch {
      // Compression failed — non-fatal, keep messages uncompressed
      // The context window will just be larger than ideal
    }
  }
}

/**
 * Get the current "awareness" — the context to inject into an agent's prompt.
 *
 * This is the conscious layer's output:
 *   1. Compressed blocks (semantic poetry) — the gist of earlier conversation
 *   2. Recent messages (full) — working memory
 *   3. The centroid of the consciousness cluster — for subconscious queries
 *
 * The agent sees this as its "awareness of the current conversation."
 */
export function getAwareness(state: ConsciousnessState): string {
  const parts: string[] = [];

  // 1. Semantic poetry from compressed blocks (the "gist")
  if (state.compressedBlocks.length > 0) {
    const poetry = state.compressedBlocks
      .map((b, i) => `${i + 1}. ${b.poetry}`)
      .join('\n');
    parts.push(`💭 CONVERSATION MEMORY (semantic poetry):\n${poetry}`);
  }

  // 2. Recent uncompressed messages (working memory)
  const recent = state.messages
    .filter((m) => !m.compressed)
    .slice(-CONSCIOUSNESS_CONFIG.workingMemorySize);

  if (recent.length > 0) {
    const recentText = recent
      .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
      .join('\n');
    parts.push(`📝 RECENT CONTEXT:\n${recentText}`);
  }

  return parts.length > 0 ? parts.join('\n\n') : '';
}

/**
 * Get the centroid (average embedding) of the consciousness cluster.
 * This is used as a query to find related patterns in the subconscious cloud.
 *
 * The centroid represents the "current thought" — the average semantic
 * direction of the conversation. It's like how a single thought can
 * trigger many related memories in the brain.
 */
export function getConsciousnessCentroid(
  state: ConsciousnessState
): number[] | null {
  const embeddings: number[][] = [];

  // Use compressed block embeddings + any message embeddings
  for (const block of state.compressedBlocks) {
    embeddings.push(block.embedding);
  }

  for (const msg of state.messages) {
    if (msg.embedding) embeddings.push(msg.embedding);
  }

  if (embeddings.length === 0) return null;

  // Average all embeddings to get the centroid
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < Math.min(dim, emb.length); i++) {
      centroid[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }

  return centroid;
}

/**
 * Expand a compressed block back into a detailed summary.
 * Uses Command A with reasoning enabled — this is the "conscious expansion"
 * of a compressed memory.
 *
 * This is like how a single thought (the poetry) can trigger the brain
 * to reconstruct the full memory — not exactly, but close enough to be useful.
 */
export async function expandMemory(
  block: CompressedBlock,
  env: Env
): Promise<string> {
  try {
    const response = await chat(
      {
        model: COHERE_MODELS.pro, // Command A for expansion (reasoning capable)
        messages: [
          {
            role: 'system',
            content:
              'You are a memory expansion engine. Given a compressed semantic poem, expand it back into a concise but detailed summary of the original conversation. 2-4 sentences max.',
          },
          {
            role: 'user',
            content: `Expand this compressed memory:\n${block.poetry}`,
          },
        ],
        maxTokens: 300,
        temperature: 0.3,
      },
      {
        COHERE_API_KEY: env.COHERE_API_KEY,
        COHERE_API_BASE: env.COHERE_BASE_URL,
      }
    );
    return response.data.message.content || block.poetry;
  } catch {
    return block.poetry; // Fallback to the compressed form
  }
}

/**
 * Promote valuable memories to the permanent cloud.
 * Called when a pipeline run completes successfully.
 *
 * This is like sleep consolidation — the brain replays the day's memories
 * and promotes the important ones to long-term storage while discarding the rest.
 */
export function getPromotableMemories(
  state: ConsciousnessState,
  pipelineSucceeded: boolean
): CompressedBlock[] {
  if (pipelineSucceeded) {
    // Promote all compressed blocks — the conversation was valuable
    return state.compressedBlocks;
  }

  // If pipeline failed, only promote blocks that contain error patterns
  // (these are valuable for learning what NOT to do)
  return state.compressedBlocks.filter(
    (b) =>
      b.poetry.toLowerCase().includes('error') ||
      b.poetry.toLowerCase().includes('fail') ||
      b.poetry.toLowerCase().includes('fix')
  );
}

/**
 * LatticeManager — Memory Lattice state (nodes/edges) + real-time WebSocket
 * fan-out. One instance per project (`idFromName(projectId)`). Called via
 * Workers RPC from the GenerationOrchestrator DO after each pipeline step
 * completes, and from `GET /ws/lattice/:projectId` for live updates.
 * See @agent_docs/architecture.md.
 */
import { DurableObject } from 'cloudflare:workers';
import { embed } from '@bicameral/cohere/embed';
import { COHERE_MODELS, LATTICE_DEFAULTS } from '@bicameral/shared/constants';
import type {
  AgentRole,
  Hemisphere,
  LatticeNodeType,
} from '@bicameral/shared/types';
import type { Env } from '../env.js';

export interface IngestAgentOutputParams {
  projectId: string;
  /** Stored on the node so findSimilar() can weight retrieval by whether
   * the run it came from actually shipped. */
  pipelineRunId: string;
  step: number;
  agentRole: AgentRole;
  label: string;
  content: unknown;
  /** Overrides the default agentRole -> node-type mapping — e.g. a Coder
   * iteration that surfaced errors enriches as `bridge` (debugging pattern)
   * instead of the default `code`. */
  nodeType?: LatticeNodeType;
}

export interface SimilarNode {
  id: string;
  label: string;
  type: string;
  score: number;
  /** The node's stored content (truncated to 8000 chars at ingest time) —
   * null if the row predates migration 003 or the content lookup missed. */
  content: string | null;
}

const STEP_TO_NODE_TYPE: Record<AgentRole, LatticeNodeType> = {
  architect: 'requirement',
  researcher: 'semantic',
  auditor: 'semantic',
  verifier: 'semantic',
  designer: 'architecture',
  coder: 'code',
};

const STEP_TO_HEMISPHERE: Record<AgentRole, Hemisphere> = {
  architect: 'left',
  researcher: 'left',
  auditor: 'left',
  verifier: 'left',
  designer: 'right',
  coder: 'right',
};

export class LatticeManager extends DurableObject<Env> {
  fetch(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(): void {
    // Clients only receive broadcasts today; no inbound protocol yet.
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // Already closing.
    }
  }

  private broadcast(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Socket gone — hibernation API will drop it on next GC.
      }
    }
  }

  /** Embeds an agent's output and stores it as a lattice node (D1 + Vectorize),
   * then broadcasts `node_added` to any connected WebSocket clients. */
  async ingestAgentOutput(
    params: IngestAgentOutputParams
  ): Promise<{ nodeId: string }> {
    const text =
      typeof params.content === 'string'
        ? params.content
        : JSON.stringify(params.content);
    const embedding = await embed(
      {
        model: COHERE_MODELS.embed,
        texts: [text.slice(0, 8000)],
        inputType: 'search_document',
      },
      {
        COHERE_API_KEY: this.env.COHERE_API_KEY,
        COHERE_API_BASE: this.env.COHERE_BASE_URL,
      }
    );
    const vector = embedding.data.embeddings.float?.[0];
    if (!vector) throw new Error('Embed response missing float embedding');

    const nodeId = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = {
      pipelineStep: params.step,
      agentRole: params.agentRole,
      pipelineRunId: params.pipelineRunId,
    };
    const nodeType = params.nodeType ?? STEP_TO_NODE_TYPE[params.agentRole];

    await this.env.LATTICE_INDEX.insert([
      {
        id: nodeId,
        values: vector,
        metadata: { projectId: params.projectId, type: nodeType, ...metadata },
      },
    ]);

    await this.env.DB.prepare(
      `INSERT INTO lattice_nodes (id, project_id, type, label, embedding_id, metadata, content, x, y, z, created_date, updated_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'system')`
    )
      .bind(
        nodeId,
        params.projectId,
        nodeType,
        params.label,
        nodeId,
        JSON.stringify(metadata),
        text.slice(0, 8000),
        now,
        now
      )
      .run();

    this.broadcast({
      type: 'node_added',
      node: {
        id: nodeId,
        type: nodeType,
        hemisphere: STEP_TO_HEMISPHERE[params.agentRole],
        label: params.label,
        metadata,
      },
    });

    return { nodeId };
  }

  /** Semantic search over past lattice nodes — used to give agents context
   * from previously generated projects of a similar type.
   *
   * Track-record weighting: a node's raw similarity score says nothing
   * about whether the pattern it came from actually worked. Each node
   * carries the `pipelineRunId` it was ingested from (see
   * ingestAgentOutput); this looks those runs up in D1 and nudges the
   * score by what actually happened — a pattern from a run that reached
   * `deployed` is preferred over one whose run ended in `error`/`paused`,
   * so a Coder pattern that shipped outranks a superficially-similar one
   * that didn't, at equal semantic similarity. Runs still in progress (no
   * outcome yet) are left at their raw score. This is the grounded,
   * data-driven version of "affect" — a success/failure history, not a
   * felt sense — see the Phase 9 Memory Lattice research memo. */
  async findSimilar(
    query: string,
    type?: LatticeNodeType
  ): Promise<SimilarNode[]> {
    const embedding = await embed(
      { model: COHERE_MODELS.embed, texts: [query], inputType: 'search_query' },
      {
        COHERE_API_KEY: this.env.COHERE_API_KEY,
        COHERE_API_BASE: this.env.COHERE_BASE_URL,
      }
    );
    const vector = embedding.data.embeddings.float?.[0];
    if (!vector) return [];

    const matches = await this.env.LATTICE_INDEX.query(vector, {
      topK:
        LATTICE_DEFAULTS.maxNodesPerUser > 20
          ? 20
          : LATTICE_DEFAULTS.maxNodesPerUser,
      filter: type ? { type } : undefined,
      returnMetadata: true,
    });

    const runIds = [
      ...new Set(
        matches.matches
          .map((m) => m.metadata?.pipelineRunId as string | undefined)
          .filter((id): id is string => !!id)
      ),
    ];
    const [outcomeByRunId, contentByNodeId] = await Promise.all([
      this.loadRunOutcomes(runIds),
      this.loadNodeContent(matches.matches.map((m) => m.id)),
    ]);

    return matches.matches
      .map((m) => {
        const runId = m.metadata?.pipelineRunId as string | undefined;
        const outcome = runId ? outcomeByRunId.get(runId) : undefined;
        return {
          id: m.id,
          label: (m.metadata?.label as string) ?? m.id,
          type: (m.metadata?.type as string) ?? 'unknown',
          content: contentByNodeId.get(m.id) ?? null,
          score: m.score * TRACK_RECORD_MULTIPLIER[outcome ?? 'unknown'],
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  private async loadNodeContent(
    nodeIds: string[]
  ): Promise<Map<string, string | null>> {
    const content = new Map<string, string | null>();
    if (nodeIds.length === 0) return content;

    const placeholders = nodeIds.map(() => '?').join(',');
    const { results } = await this.env.DB.prepare(
      `SELECT id, content FROM lattice_nodes WHERE id IN (${placeholders})`
    )
      .bind(...nodeIds)
      .all<{ id: string; content: string | null }>();

    for (const row of results) {
      content.set(row.id, row.content);
    }
    return content;
  }

  private async loadRunOutcomes(
    runIds: string[]
  ): Promise<Map<string, RunOutcome>> {
    const outcomes = new Map<string, RunOutcome>();
    if (runIds.length === 0) return outcomes;

    const placeholders = runIds.map(() => '?').join(',');
    const { results } = await this.env.DB.prepare(
      `SELECT id, status FROM pipeline_runs WHERE id IN (${placeholders})`
    )
      .bind(...runIds)
      .all<{ id: string; status: string }>();

    for (const row of results) {
      outcomes.set(row.id, RUN_STATUS_TO_OUTCOME[row.status] ?? 'unknown');
    }
    return outcomes;
  }
}

type RunOutcome = 'shipped' | 'failed' | 'unknown';

const RUN_STATUS_TO_OUTCOME: Record<string, RunOutcome> = {
  deployed: 'shipped',
  error: 'failed',
  paused: 'failed',
};

// Deliberately mild — this nudges ranking, it doesn't gate retrieval.
// A failed run's pattern can still be the best available match; it just
// shouldn't outrank an equally-similar one that's proven to work.
const TRACK_RECORD_MULTIPLIER: Record<RunOutcome, number> = {
  shipped: 1.15,
  failed: 0.7,
  unknown: 1,
};

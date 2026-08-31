/**
 * Repo-scoped Memory Lattice retrieval for the flagship chat agent.
 *
 * A correction to the brief, stated rather than worked around: the directive
 * said to "wire the General Flagship Agent to the routes/lattice.ts webhook".
 * `routes/lattice.ts` has no webhook. It is authenticated node/edge CRUD behind
 * `requireAuth`, mounted after the auth middleware, and its handlers read
 * `c.get('userId')` from a Better Auth session the FluxyChat agent runtime does
 * not have and cannot obtain. Adding one to it would mean a second, unversioned
 * copy of the ownership checks on the far side of the auth boundary — the exact
 * shape of the IDOR that was just removed from the tool webhook.
 *
 * So retrieval goes through the callback that already exists and already
 * establishes identity: `POST /api/chat/webhook/tools/execute`, whose caller is
 * resolved from a server-minted capability token. This module is the read side
 * of that tool. It never takes a `userId` argument from the model — the id is
 * threaded down from `resolveChatToolToken`, and every query joins `projects`
 * on it, so a project id the model invents resolves to nothing rather than to
 * someone else's lattice.
 *
 * Retrieval is lexical (LIKE over label and metadata), not vector search. That
 * is a deliberate limit and worth knowing before someone "upgrades" it:
 * Vectorize holds embeddings keyed by `embedding_id`, but Cohere embeddings are
 * not deterministic across identical requests (CLAUDE.md, "Other known gaps"),
 * so an embed-per-chat-turn would spend a Cohere call to get a query vector
 * that does not stably match the vector written at index time. A LIKE scan over
 * one founder's nodes is bounded, needs no second service on the chat path, and
 * returns rows whose provenance the reader can check.
 */
import type { LatticeNodeType } from '@bicameral/shared/types';

/** Hard ceiling on rows returned to the model, whatever the caller asks for. */
export const LATTICE_CONTEXT_MAX_NODES = 20;

/**
 * How many neighbours a returned node may carry. Small on purpose: the payload
 * lands in a chat model's context, and an unbounded ego-network on a mature
 * project is thousands of rows that push the founder's actual question out of
 * the window.
 */
export const LATTICE_CONTEXT_MAX_EDGES = 40;

export interface LatticeContextNode {
  id: string;
  projectId: string;
  projectName: string;
  type: string;
  label: string;
  /** Only the fields worth a model's attention — see `summarizeMetadata`. */
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface LatticeContextEdge {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
}

export interface LatticeContext {
  query: string;
  /** Present when the caller scoped to one project AND owns it. */
  projectId: string | null;
  nodes: LatticeContextNode[];
  edges: LatticeContextEdge[];
  /**
   * True when the scan hit `LATTICE_CONTEXT_MAX_NODES`. The agent is told to
   * say so rather than presenting a truncated view as the whole lattice.
   */
  truncated: boolean;
}

interface NodeRow {
  id: string;
  project_id: string;
  project_name: string;
  type: string;
  label: string;
  metadata: string | null;
  updated_date: string;
}

interface EdgeRow {
  source_node_id: string;
  target_node_id: string;
  type: string;
  weight: number;
}

/**
 * Metadata is written by lattice-enrich.ts and by hand through the CRUD routes,
 * so it is an open bag. Only the keys that describe provenance are forwarded;
 * anything else could be arbitrary founder content of unbounded size, and this
 * payload is going into a model's context.
 */
const FORWARDED_METADATA_KEYS = [
  'pipeline_step',
  'agent_role',
  'source',
  'run_id',
] as const;

function summarizeMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed blob is a data defect, not a reason to fail the chat turn.
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const bag = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of FORWARDED_METADATA_KEYS) {
    if (bag[key] !== undefined) out[key] = bag[key];
  }
  return out;
}

/**
 * Escapes the LIKE metacharacters so a founder searching for "100%" gets the
 * literal string rather than a wildcard that matches their whole lattice. The
 * queries below declare `ESCAPE '\'` to match.
 */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export interface LatticeContextRequest {
  /** Free text from the founder's message. Empty means "most recent work". */
  query?: string;
  /** Optional narrowing. Ignored unless the caller owns the project. */
  projectId?: string | null;
  limit?: number;
}

/**
 * Reads lattice nodes belonging to `userId`, optionally within one project.
 *
 * Returns an empty context rather than throwing when the founder has no
 * matching nodes or named a project they do not own. Those two cases are
 * deliberately indistinguishable to the caller: an error that says "project not
 * found" versus "not yours" is an ownership oracle, and this result is going
 * into a model that will repeat it out loud.
 */
export async function fetchLatticeContext(
  db: D1Database,
  userId: string,
  request: LatticeContextRequest = {}
): Promise<LatticeContext> {
  const query = (request.query ?? '').trim();
  const limit = Math.min(
    Math.max(1, request.limit ?? LATTICE_CONTEXT_MAX_NODES),
    LATTICE_CONTEXT_MAX_NODES
  );
  const projectId = request.projectId?.trim() || null;

  // The ownership join is on every path — there is no branch where a projectId
  // is trusted on its own.
  const where = ['p.user_id = ?'];
  const binds: unknown[] = [userId];
  if (projectId) {
    where.push('n.project_id = ?');
    binds.push(projectId);
  }
  if (query) {
    where.push("(n.label LIKE ? ESCAPE '\\' OR n.metadata LIKE ? ESCAPE '\\')");
    const pattern = likePattern(query);
    binds.push(pattern, pattern);
  }

  // Ordered newest-first so an empty query answers "what were we just doing",
  // which is the question a founder opening a chat is usually asking.
  const nodeRows = await db
    .prepare(
      `SELECT n.id, n.project_id, p.name AS project_name, n.type, n.label,
              n.metadata, n.updated_date
         FROM lattice_nodes n
         JOIN projects p ON p.id = n.project_id
        WHERE ${where.join(' AND ')}
        ORDER BY n.updated_date DESC
        LIMIT ?`
    )
    .bind(...binds, limit + 1)
    .all<NodeRow>();

  const rows = nodeRows.results ?? [];
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;

  const nodes: LatticeContextNode[] = kept.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    type: row.type,
    label: row.label,
    metadata: summarizeMetadata(row.metadata),
    updatedAt: row.updated_date,
  }));

  let edges: LatticeContextEdge[] = [];
  if (nodes.length > 0) {
    // Edges only *between returned nodes*. An edge to a node that was filtered
    // out names an id the model cannot resolve, and a model given a dangling
    // reference tends to describe it as though it had read it.
    const ids = nodes.map((n) => n.id);
    const placeholders = ids.map(() => '?').join(',');
    const edgeRows = await db
      .prepare(
        `SELECT source_node_id, target_node_id, type, weight
           FROM lattice_edges
          WHERE source_node_id IN (${placeholders})
            AND target_node_id IN (${placeholders})
          LIMIT ?`
      )
      .bind(...ids, ...ids, LATTICE_CONTEXT_MAX_EDGES)
      .all<EdgeRow>();
    edges = (edgeRows.results ?? []).map((row) => ({
      sourceId: row.source_node_id,
      targetId: row.target_node_id,
      type: row.type,
      weight: row.weight,
    }));
  }

  return {
    query,
    // Echoing the projectId only when it survived the ownership join means a
    // caller can tell scoping applied; an unowned id comes back as null with an
    // empty node list, same as a project with no nodes.
    projectId: nodes.length > 0 && projectId ? projectId : null,
    nodes,
    edges,
    truncated,
  };
}

/**
 * Groups a context by node type. Used by the builder-block suggester, which
 * reasons about what kinds of thing a project already has.
 */
export function countByType(context: LatticeContext): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of context.nodes) {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
  }
  return counts;
}

/** Re-exported so callers can name node types without importing shared twice. */
export type { LatticeNodeType };

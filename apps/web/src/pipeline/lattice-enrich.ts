/**
 * Memory Lattice enrichment — called by GenerationOrchestrator after each
 * pipeline step to embed the agent's output via LatticeManager (Phase 4).
 * Step mapping per @agent_docs/autonomous-dev-team.md "Memory Lattice
 * Integration": architect -> requirement nodes, researcher -> semantic
 * nodes, designer -> architecture (implementation) nodes, coder -> code
 * nodes on success or bridge nodes when an iteration surfaced errors/fixes
 * (the debugging-pattern case bridge nodes exist for).
 */
import type { AgentRole, LatticeNodeType } from '@bicameral/shared/types';
import type { Env } from '../env.js';

export interface SimilarPattern {
  id: string;
  label: string;
  type: string;
  score: number;
  /** Truncated (8000 char) copy of the node's original content — null for
   * pre-migration-003 rows. */
  content: string | null;
}

interface LatticeManagerStub {
  ingestAgentOutput(params: {
    projectId: string;
    pipelineRunId: string;
    step: number;
    agentRole: AgentRole;
    label: string;
    content: unknown;
    nodeType?: LatticeNodeType;
  }): Promise<{ nodeId: string }>;
  findSimilar(query: string, type?: LatticeNodeType): Promise<SimilarPattern[]>;
}

function stub(env: Env, projectId: string): LatticeManagerStub {
  return env.LATTICE_DO.get(
    env.LATTICE_DO.idFromName(projectId)
  ) as unknown as LatticeManagerStub;
}

export interface EnrichOptions {
  /** Overrides the default step -> node-type mapping — e.g. a Coder
   * iteration that found errors enriches as a `bridge` (debugging pattern)
   * node instead of the default `code` node. */
  nodeType?: LatticeNodeType;
}

/** Best-effort — lattice enrichment never blocks or fails the pipeline.
 * `pipelineRunId` is stored on the node so `findSimilar()` can later weight
 * retrieval by whether the run it came from actually shipped — see
 * LatticeManager.findSimilar's track-record note. */
export async function enrichLattice(
  env: Env,
  projectId: string | null,
  pipelineRunId: string,
  step: number,
  agentRole: AgentRole,
  label: string,
  content: unknown,
  options: EnrichOptions = {}
): Promise<void> {
  if (!projectId) return;
  try {
    await stub(env, projectId).ingestAgentOutput({
      projectId,
      pipelineRunId,
      step,
      agentRole,
      label,
      content,
      nodeType: options.nodeType,
    });
  } catch {
    // Non-fatal — see module docstring.
  }
}

/** Retrieves similar past patterns for agent context — e.g. "what did we
 * do the last time someone built a marketplace app." Best-effort: returns
 * an empty list rather than throwing if the lattice is unavailable, and
 * (like enrichLattice) a no-op when there's no project to scope the
 * lattice to — e.g. researcher.ts's standalone-use path. */
export async function findSimilarPatterns(
  env: Env,
  projectId: string | null,
  query: string,
  type?: LatticeNodeType
): Promise<SimilarPattern[]> {
  if (!projectId) return [];
  try {
    return await stub(env, projectId).findSimilar(query, type);
  } catch {
    return [];
  }
}

/** Renders retrieved patterns as a prompt block. Content-less matches
 * (pre-migration-003 rows) fall back to just the label so a thin lattice
 * still contributes something. Empty input renders to '' — callers can
 * append it unconditionally. */
export function formatSimilarPatterns(
  patterns: SimilarPattern[],
  heading: string
): string {
  if (patterns.length === 0) return '';
  const items = patterns
    .slice(0, 3)
    .map(
      (p) => `- ${p.label}${p.content ? `: ${p.content.slice(0, 500)}` : ''}`
    )
    .join('\n');
  return `\n\n${heading} (for context — adapt, don't copy verbatim):\n${items}`;
}

/**
 * Builder block suggestions, derived from the Memory Lattice.
 *
 * What this module proposes and what it refuses to claim are both deliberate.
 *
 * **A correction to the brief, stated rather than worked around.** The
 * directive asked for recommendations "based on user intent vectors". There are
 * no intent vectors in this repo to base anything on. `lattice_nodes.embedding_id`
 * points into Vectorize, and CLAUDE.md records the measurement that makes that
 * a dead end here: Cohere embeddings are not deterministic across identical
 * requests, so a vector computed now does not stably match the one written at
 * index time. Building a suggester on top of that would produce output that
 * looks quantitative, cannot be reproduced, and would be read as evidence.
 *
 * What exists instead is a record of what the founder's own pipeline runs
 * decided: `requirement` and `architecture` nodes with labels the agents wrote.
 * So a suggestion here is a **gap between two records** — something the lattice
 * says the project needs, that the current blueprint has no component for — and
 * every suggestion carries the node ids it came from so the founder can open
 * them and disagree.
 *
 * **No scores.** No confidence percentage, no relevance figure, no ranking
 * number reaches this output (ground rule 2). Suggestions are ordered by how
 * recently their source node was updated, which is a fact about the data rather
 * than a judgement dressed as one. `block-suggestions.test.ts` asserts the
 * absence of `%`.
 *
 * **Proposals, never applications.** Nothing here writes a blueprint, a
 * component, or a lattice node. The output is a list the founder reads at the
 * review gate; acting on one is a separate act by a person. Same boundary as
 * the simulation watchdog (§CORRECTION 7).
 */
import type { LatticeContext, LatticeContextNode } from './lattice-context.js';

/**
 * The node types that describe something a project needs. `semantic`, `code`
 * and `cluster` are excluded on purpose: the first two record what was already
 * said or already written, and a cluster is a grouping rather than a claim.
 */
const INTENT_NODE_TYPES = new Set(['requirement', 'architecture', 'bridge']);

export interface BlockSuggestion {
  /** Stable within one response; suitable as a React key, not a database id. */
  id: string;
  /** The block to consider adding, in the founder's own recorded words. */
  title: string;
  /** Why it is being proposed — always a statement about the record. */
  rationale: string;
  /** Suggested BlueprintComponent.type, so the builder can pre-fill one. */
  blockType: 'page' | 'component' | 'api' | 'util' | 'schema' | 'config';
  /** The lattice nodes this came from. Never empty. */
  sourceNodeIds: string[];
  /** Shown beside the suggestion so the source is visible, not just linkable. */
  sourceLabels: string[];
}

export interface ExistingComponent {
  path: string;
  description: string;
}

/**
 * Maps a recorded requirement to the kind of block it most likely wants.
 *
 * This is keyword matching over labels the agents wrote, and it is not clever.
 * It is honest about being a heuristic: `blockType` is a pre-fill for a form
 * the founder is about to edit, not a classification anything downstream
 * depends on. The default is `component` because that is the least committal
 * thing to scaffold.
 */
function inferBlockType(label: string): BlockSuggestion['blockType'] {
  const text = label.toLowerCase();
  if (/\b(endpoint|api|route|webhook)\b/.test(text)) return 'api';
  if (/\b(table|schema|model|migration|column)\b/.test(text)) return 'schema';
  if (/\b(page|screen|view|dashboard)\b/.test(text)) return 'page';
  if (/\b(config|setting|environment|flag)\b/.test(text)) return 'config';
  if (/\b(helper|utility|parser|formatter)\b/.test(text)) return 'util';
  return 'component';
}

/**
 * Words too common to mean anything on their own. Without this, a requirement
 * labelled "user data export" matches any component whose description happens
 * to contain "user", and the suggester silently proposes nothing on a busy
 * project — the failure mode where a feature looks fine because it is quiet.
 */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'that',
  'this',
  'it',
  'is',
  'be',
  'as',
  'by',
  'from',
  'at',
  'user',
  'users',
  'app',
  'application',
  'system',
  'support',
  'add',
  'new',
]);

function significantTerms(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word));
}

/**
 * True when the blueprint already appears to cover this node.
 *
 * "Appears to" is the honest verb. This is term overlap against component
 * paths and descriptions, so it will both miss coverage phrased differently and
 * occasionally suppress a real gap. That asymmetry is chosen: a suppressed
 * suggestion costs the founder nothing they can see, while a proposal for
 * something already built costs them the trust that these are worth reading.
 */
function isAlreadyCovered(
  node: LatticeContextNode,
  components: ExistingComponent[]
): boolean {
  const terms = significantTerms(node.label);
  if (terms.length === 0) return true; // nothing specific enough to propose
  return components.some((component) => {
    const haystack = `${component.path} ${component.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface SuggestBlocksInput {
  /** Lattice rows for the project, already scoped to the owner. */
  context: LatticeContext;
  /** What the blueprint currently contains. */
  components: ExistingComponent[];
  /** Hard cap on how many proposals to return. */
  limit?: number;
}

export const MAX_BLOCK_SUGGESTIONS = 5;

/**
 * Derives block suggestions. Pure — no D1, no network, no clock — so the
 * reasoning can be tested from a node environment, the same reason
 * `pipeline-legibility.ts` has no React import.
 */
export function suggestBlocks(input: SuggestBlocksInput): BlockSuggestion[] {
  const limit = Math.min(
    Math.max(0, input.limit ?? MAX_BLOCK_SUGGESTIONS),
    MAX_BLOCK_SUGGESTIONS
  );
  if (limit === 0) return [];

  const seen = new Set<string>();
  const suggestions: BlockSuggestion[] = [];

  // context.nodes arrives newest-first from fetchLatticeContext; that ordering
  // is the whole ranking. See the header on why there is no score.
  for (const node of input.context.nodes) {
    if (suggestions.length >= limit) break;
    if (!INTENT_NODE_TYPES.has(node.type)) continue;
    if (isAlreadyCovered(node, input.components)) continue;

    // Two runs recording the same requirement should propose one block.
    const key = node.label.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const origin =
      typeof node.metadata.agent_role === 'string'
        ? `the ${node.metadata.agent_role}`
        : 'an earlier run';

    suggestions.push({
      id: `suggest-${node.id}`,
      title: node.label,
      rationale:
        `${origin} recorded this for ${node.projectName} on ` +
        `${node.updatedAt.slice(0, 10)}, and the current blueprint has no ` +
        `component that matches it.`,
      blockType: inferBlockType(node.label),
      sourceNodeIds: [node.id],
      sourceLabels: [node.label],
    });
  }

  return suggestions;
}

/**
 * The sentence shown when there is nothing to propose.
 *
 * It exists as an export because "no suggestions" has two meanings a founder
 * must be able to tell apart — the lattice is empty, or the lattice is covered
 * — and a component rendering an empty list says neither.
 */
export function emptySuggestionReason(input: SuggestBlocksInput): string {
  if (input.context.nodes.length === 0) {
    return "This project's Memory Lattice has nothing recorded yet, so there is nothing to suggest from. It fills up as runs complete.";
  }
  return 'Everything recorded in this project’s Memory Lattice already has a component in this blueprint.';
}

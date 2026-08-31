import { describe, expect, it } from 'vitest';
import type { LatticeContext, LatticeContextNode } from './lattice-context.js';
import {
  MAX_BLOCK_SUGGESTIONS,
  emptySuggestionReason,
  suggestBlocks,
} from './block-suggestions.js';

function node(
  over: Partial<LatticeContextNode> & { id: string; label: string }
): LatticeContextNode {
  return {
    projectId: 'proj-1',
    projectName: 'Ledger',
    type: 'requirement',
    metadata: {},
    updatedAt: '2026-08-30T10:00:00.000Z',
    ...over,
  };
}

function context(nodes: LatticeContextNode[]): LatticeContext {
  return { query: '', projectId: 'proj-1', nodes, edges: [], truncated: false };
}

describe('suggestBlocks proposes gaps between two records', () => {
  it('proposes a requirement the blueprint has no component for', () => {
    const out = suggestBlocks({
      context: context([
        node({ id: 'n1', label: 'CSV export endpoint for invoices' }),
      ]),
      components: [
        { path: 'src/pages/Invoices.tsx', description: 'invoice list' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('CSV export endpoint for invoices');
    expect(out[0].blockType).toBe('api');
    // The founder must be able to go and read the thing this came from.
    expect(out[0].sourceNodeIds).toEqual(['n1']);
  });

  it('stays silent about a requirement the blueprint already covers', () => {
    const out = suggestBlocks({
      context: context([node({ id: 'n1', label: 'invoice export' })]),
      components: [
        { path: 'src/api/export.ts', description: 'invoice export handler' },
      ],
    });
    expect(out).toEqual([]);
  });

  it('ignores node types that record what was said, not what is needed', () => {
    // `semantic` and `code` describe the past; proposing a block from them
    // would recommend rebuilding what exists.
    const out = suggestBlocks({
      context: context([
        node({ id: 'n1', label: 'unmatched thing one', type: 'semantic' }),
        node({ id: 'n2', label: 'unmatched thing two', type: 'code' }),
        node({ id: 'n3', label: 'unmatched thing three', type: 'cluster' }),
      ]),
      components: [],
    });
    expect(out).toEqual([]);
  });

  it('proposes one block when two runs recorded the same requirement', () => {
    const out = suggestBlocks({
      context: context([
        node({ id: 'n1', label: 'Webhook retry queue' }),
        node({ id: 'n2', label: 'webhook retry queue  ' }),
      ]),
      components: [],
    });
    expect(out).toHaveLength(1);
  });

  it('never returns more than the cap, whatever the caller asks for', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      node({ id: `n${i}`, label: `distinct requirement number ${i}alpha` })
    );
    const out = suggestBlocks({
      context: context(many),
      components: [],
      limit: 999,
    });
    expect(out).toHaveLength(MAX_BLOCK_SUGGESTIONS);
  });

  it('names the agent that recorded it when the lattice says which', () => {
    const out = suggestBlocks({
      context: context([
        node({
          id: 'n1',
          label: 'Rate limiting configuration',
          metadata: { agent_role: 'verifier' },
        }),
      ]),
      components: [],
    });
    expect(out[0].rationale).toContain('the verifier');
    expect(out[0].rationale).toContain('2026-08-30');
  });

  it('formats no percentage anywhere in its output', () => {
    // Ground rule 2. A recommendation list is the likeliest place to grow a
    // "87% match" by accident, and it would be read as a measurement.
    const out = suggestBlocks({
      context: context([
        node({ id: 'n1', label: 'Audit log page', type: 'architecture' }),
        node({ id: 'n2', label: 'Session timeout config' }),
      ]),
      components: [],
    });
    expect(JSON.stringify(out)).not.toContain('%');
  });
});

describe('an empty result says which kind of empty it is', () => {
  it('distinguishes an empty lattice from a covered one', () => {
    const empty = { context: context([]), components: [] };
    const covered = {
      context: context([node({ id: 'n1', label: 'invoice export' })]),
      components: [
        { path: 'src/api/export.ts', description: 'invoice export handler' },
      ],
    };
    expect(emptySuggestionReason(empty)).toContain('nothing recorded yet');
    expect(emptySuggestionReason(covered)).toContain('already has a component');
    expect(emptySuggestionReason(empty)).not.toBe(
      emptySuggestionReason(covered)
    );
  });
});

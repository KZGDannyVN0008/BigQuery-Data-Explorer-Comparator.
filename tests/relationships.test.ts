import { describe, expect, it } from 'vitest';
import { buildGraph, confidenceFor, edgeKey, formatCondition, mergeEdges, type RawEdge } from '@/lib/relationships';
import type { TableRef } from '@/lib/types';

const gold: TableRef = { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'ph_dpp_deposit_v2_gold' };
const kura: TableRef = { project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' };
const dim: TableRef = { project: 'kz-dp-prod', dataset: 'crm_gold_prod', table: 'merchant_dim' };

describe('formatCondition', () => {
  it('renders the predicate the UI displays', () => {
    expect(formatCondition(gold, 'merchant', dim, 'merchant')).toBe(
      'ph_dpp_deposit_v2_gold.merchant = merchant_dim.merchant',
    );
  });
});

describe('edgeKey', () => {
  it('is direction-insensitive so a pair is never duplicated', () => {
    expect(edgeKey(gold, kura)).toBe(edgeKey(kura, gold));
  });
});

describe('confidenceFor', () => {
  it('ranks manual confirmation highest and join history lowest', () => {
    expect(confidenceFor('manual')).toBe(1);
    expect(confidenceFor('foreign_key')).toBeGreaterThan(confidenceFor('lineage'));
    expect(confidenceFor('join_history', 1)).toBeLessThan(confidenceFor('lineage'));
  });

  it('raises join-history confidence with more observations, but caps it', () => {
    expect(confidenceFor('join_history', 200)).toBeGreaterThan(confidenceFor('join_history', 2));
    expect(confidenceFor('join_history', 1_000_000)).toBeLessThanOrEqual(0.95);
  });
});

describe('mergeEdges', () => {
  const lineageEdge: RawEdge = {
    from: kura,
    to: gold,
    direction: 'upstream',
    source: 'lineage',
    columnPairs: [],
    evidence: '212 jobs read ph_deposit_v2 and wrote ph_dpp_deposit_v2_gold',
    observations: 212,
  };

  const joinEdge: RawEdge = {
    from: gold,
    to: kura,
    direction: 'peer',
    source: 'join_history',
    columnPairs: [{ fromColumn: 'transaction_id', toColumn: 'transaction_id' }],
    evidence: 'Observed in 64 queries',
    observations: 64,
  };

  it('collapses two sources describing the same pair into one edge', () => {
    const merged = mergeEdges(gold, [lineageEdge, joinEdge]);
    expect(merged).toHaveLength(1);
    expect(merged[0].conditions).toContain('ph_deposit_v2.transaction_id = ph_dpp_deposit_v2_gold.transaction_id');
  });

  it('keeps the strongest source and its evidence', () => {
    const merged = mergeEdges(gold, [joinEdge, lineageEdge]);
    expect(merged[0].source).toBe('lineage');
    expect(merged[0].evidence).toContain('other source');
  });

  it('prefers a directional edge over a peer edge', () => {
    const merged = mergeEdges(gold, [joinEdge, lineageEdge]);
    expect(merged[0].direction).toBe('upstream');
  });

  it('reorients column pairs when the merged edge points the other way', () => {
    const merged = mergeEdges(gold, [lineageEdge, joinEdge]);
    // The winning orientation is kura -> gold, so the pair must read that way too.
    expect(merged[0].from.table).toBe('ph_deposit_v2');
    expect(merged[0].columnPairs).toEqual([{ fromColumn: 'transaction_id', toColumn: 'transaction_id' }]);
  });

  it('drops self-referential edges', () => {
    const merged = mergeEdges(gold, [{ ...lineageEdge, from: gold, to: gold }]);
    expect(merged).toHaveLength(0);
  });

  it('sorts the strongest evidence first', () => {
    const manual: RawEdge = {
      from: gold,
      to: dim,
      direction: 'peer',
      source: 'manual',
      columnPairs: [{ fromColumn: 'merchant', toColumn: 'merchant' }],
      evidence: 'Confirmed by the CRM team',
    };
    const merged = mergeEdges(gold, [joinEdge, manual]);
    expect(merged[0].source).toBe('manual');
    expect(merged[0].confidence).toBe(1);
  });
});

describe('buildGraph', () => {
  it('places neighbours relative to the root and keeps the root once', () => {
    const graph = buildGraph(gold, [
      {
        from: kura,
        to: gold,
        direction: 'upstream',
        source: 'lineage',
        columnPairs: [],
        evidence: 'lineage',
        observations: 10,
      },
      {
        from: gold,
        to: dim,
        direction: 'downstream',
        source: 'lineage',
        columnPairs: [],
        evidence: 'lineage',
        observations: 5,
      },
    ]);

    expect(graph.nodes.filter((n) => n.direction === 'root')).toHaveLength(1);
    expect(graph.nodes.find((n) => n.ref.table === 'ph_deposit_v2')?.direction).toBe('upstream');
    expect(graph.nodes.find((n) => n.ref.table === 'merchant_dim')?.direction).toBe('downstream');
  });

  it('returns only the root when there is no evidence at all', () => {
    const graph = buildGraph(gold, []);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it('carries warnings through to the UI', () => {
    const graph = buildGraph(gold, [], ['Lineage unavailable: permission denied']);
    expect(graph.warnings[0]).toContain('permission denied');
  });
});

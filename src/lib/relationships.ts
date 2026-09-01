/**
 * Merges relationship evidence from all sources into a single graph.
 *
 * Rule that shapes this whole module: a shared column name is NOT evidence.
 * Every edge must trace back to lineage, a declared constraint, an observed JOIN
 * predicate, or a human confirmation — and the edge carries which one.
 */

import { refToString } from './identifiers';
import type {
  RelationshipEdge,
  RelationshipGraph,
  RelationshipSource,
  RelationshipDirection,
  TableRef,
} from './types';

/** Confidence floor per evidence type. Join history additionally scales with volume. */
const BASE_CONFIDENCE: Record<RelationshipSource, number> = {
  manual: 1,
  foreign_key: 0.95,
  primary_key: 0.9,
  lineage: 0.7,
  join_history: 0.5,
};

const SOURCE_RANK: RelationshipSource[] = ['manual', 'foreign_key', 'primary_key', 'lineage', 'join_history'];

export function sameRef(a: TableRef, b: TableRef): boolean {
  return a.project === b.project && a.dataset === b.dataset && a.table === b.table;
}

/** Stable, direction-insensitive identity so the same pair never appears twice. */
export function edgeKey(a: TableRef, b: TableRef): string {
  const [first, second] = [refToString(a), refToString(b)].sort();
  return `${first}::${second}`;
}

/** `kz-dp-prod.crm_gold_prod.orders.merchant = kz-kura.ph.deposits.merchant` */
export function formatCondition(
  from: TableRef,
  fromColumn: string,
  to: TableRef,
  toColumn: string,
): string {
  return `${from.table}.${fromColumn} = ${to.table}.${toColumn}`;
}

export interface RawEdge {
  from: TableRef;
  to: TableRef;
  direction: RelationshipDirection;
  source: RelationshipSource;
  columnPairs: Array<{ fromColumn: string; toColumn: string }>;
  evidence: string;
  observations?: number;
}

/** Join-history confidence grows with how often the predicate was actually used. */
export function confidenceFor(source: RelationshipSource, observations = 0): number {
  const base = BASE_CONFIDENCE[source];
  if (source !== 'join_history') return base;
  const boost = Math.min(0.4, Math.log10(Math.max(1, observations) + 1) * 0.2);
  return Number(Math.min(0.95, base + boost).toFixed(2));
}

/**
 * Collapses raw evidence into one edge per table pair, keeping the strongest
 * source, the union of column pairs, and the combined observation count.
 */
export function mergeEdges(root: TableRef, raw: RawEdge[]): RelationshipEdge[] {
  const byPair = new Map<string, RelationshipEdge & { sources: Set<RelationshipSource> }>();

  for (const item of raw) {
    if (sameRef(item.from, item.to)) continue;
    const key = edgeKey(item.from, item.to);
    const existing = byPair.get(key);

    const pairs = item.columnPairs.filter((p) => p.fromColumn && p.toColumn);
    const conditions = pairs.map((p) => formatCondition(item.from, p.fromColumn, item.to, p.toColumn));

    if (!existing) {
      byPair.set(key, {
        id: key,
        from: item.from,
        to: item.to,
        direction: item.direction,
        source: item.source,
        conditions: [...new Set(conditions)],
        columnPairs: dedupePairs(pairs),
        confidence: confidenceFor(item.source, item.observations),
        evidence: item.evidence,
        observations: item.observations,
        sources: new Set([item.source]),
      });
      continue;
    }

    existing.sources.add(item.source);
    existing.observations = (existing.observations ?? 0) + (item.observations ?? 0);

    // Column pairs are stored relative to the winning edge's orientation.
    const flip = !sameRef(existing.from, item.from);
    const oriented = pairs.map((p) =>
      flip ? { fromColumn: p.toColumn, toColumn: p.fromColumn } : p,
    );
    existing.columnPairs = dedupePairs([...existing.columnPairs, ...oriented]);
    existing.conditions = [
      ...new Set([
        ...existing.conditions,
        ...existing.columnPairs.map((p) =>
          formatCondition(existing.from, p.fromColumn, existing.to, p.toColumn),
        ),
      ]),
    ];

    if (SOURCE_RANK.indexOf(item.source) < SOURCE_RANK.indexOf(existing.source)) {
      existing.source = item.source;
      existing.evidence = item.evidence;
    }
    // Lineage direction is more meaningful than a peer relationship.
    if (existing.direction === 'peer' && item.direction !== 'peer') {
      existing.direction = item.direction;
    }
    existing.confidence = Math.max(
      existing.confidence,
      confidenceFor(existing.source, existing.observations),
    );
  }

  return [...byPair.values()]
    .map(({ sources, ...edge }) => ({
      ...edge,
      evidence: sources.size > 1 ? `${edge.evidence} (+${sources.size - 1} other source${sources.size > 2 ? 's' : ''})` : edge.evidence,
    }))
    .filter((edge) => sameRef(edge.from, root) || sameRef(edge.to, root) || edge.columnPairs.length > 0)
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}

function dedupePairs(pairs: Array<{ fromColumn: string; toColumn: string }>) {
  const seen = new Set<string>();
  const out: Array<{ fromColumn: string; toColumn: string }> = [];
  for (const p of pairs) {
    const key = `${p.fromColumn}=${p.toColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function buildGraph(root: TableRef, raw: RawEdge[], warnings: string[] = []): RelationshipGraph {
  const edges = mergeEdges(root, raw);
  const nodes = new Map<string, { ref: TableRef; direction: RelationshipDirection | 'root' }>();
  nodes.set(refToString(root), { ref: root, direction: 'root' });

  for (const edge of edges) {
    const other = sameRef(edge.from, root) ? edge.to : sameRef(edge.to, root) ? edge.from : null;
    if (!other) continue;
    const key = refToString(other);
    if (nodes.has(key)) continue;
    // `direction` always describes the neighbour relative to the root, never the
    // edge's own from/to orientation, so it transfers to the node unchanged.
    nodes.set(key, { ref: other, direction: edge.direction });
  }

  return { root, nodes: [...nodes.values()], edges, warnings };
}

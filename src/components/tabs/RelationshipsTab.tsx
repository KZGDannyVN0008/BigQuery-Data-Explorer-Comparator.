'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { apiGet } from '@/lib/client';
import type { GeneratedSql, RelationshipEdge, RelationshipGraph, TableMetadata, TableRef } from '@/lib/types';
import { Badge, Empty, Notice, Panel, Spinner } from '../ui';

const SOURCE_LABEL: Record<RelationshipEdge['source'], string> = {
  manual: 'Manually confirmed',
  foreign_key: 'Foreign key',
  primary_key: 'Primary key',
  lineage: 'Lineage',
  join_history: 'JOIN history',
};

const SOURCE_TONE: Record<RelationshipEdge['source'], 'good' | 'accent' | 'warn' | undefined> = {
  manual: 'good',
  foreign_key: 'accent',
  primary_key: 'accent',
  lineage: undefined,
  join_history: 'warn',
};

interface TableNodeData extends Record<string, unknown> {
  ref: TableRef;
  direction: 'root' | 'upstream' | 'downstream' | 'peer';
  onSelect: (ref: TableRef) => void;
}

function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { ref, direction, onSelect } = data;
  return (
    <div className={`node-card ${direction}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{ref.table}</div>
      <div className="node-path">
        {ref.project}.{ref.dataset}
      </div>
      <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.35rem', alignItems: 'center' }}>
        <Badge tone={direction === 'root' ? 'accent' : direction === 'upstream' ? 'good' : undefined}>
          {direction}
        </Badge>
        {direction !== 'root' ? (
          <button type="button" className="ghost" onClick={() => onSelect(ref)} style={{ fontSize: 11 }}>
            Open
          </button>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { table: TableNode };

/** Upstream on the left, the root in the middle, downstream on the right. */
function layout(graph: RelationshipGraph, onSelect: (ref: TableRef) => void): Node<TableNodeData>[] {
  const columns: Record<'upstream' | 'root' | 'downstream' | 'peer', typeof graph.nodes> = {
    upstream: [],
    root: [],
    downstream: [],
    peer: [],
  };
  for (const node of graph.nodes) columns[node.direction].push(node);

  const x = { upstream: 0, root: 420, peer: 420, downstream: 840 };
  const nodes: Node<TableNodeData>[] = [];

  for (const key of ['upstream', 'root', 'downstream', 'peer'] as const) {
    columns[key].forEach((entry, index) => {
      const offset = key === 'peer' ? 220 + index * 140 : index * 140;
      nodes.push({
        id: `${entry.ref.project}.${entry.ref.dataset}.${entry.ref.table}`,
        type: 'table',
        position: { x: x[key], y: key === 'root' ? 0 : offset - (columns[key].length - 1) * 70 },
        data: { ref: entry.ref, direction: entry.direction, onSelect },
        draggable: true,
      });
    });
  }
  return nodes;
}

function toFlowEdges(graph: RelationshipGraph, selected: string | null): Edge[] {
  return graph.edges.map((edge) => {
    const id = edge.id;
    const label = edge.conditions.length > 0 ? edge.conditions[0] : SOURCE_LABEL[edge.source];
    return {
      id,
      source: `${edge.from.project}.${edge.from.dataset}.${edge.from.table}`,
      target: `${edge.to.project}.${edge.to.dataset}.${edge.to.table}`,
      label: edge.conditions.length > 1 ? `${label} (+${edge.conditions.length - 1})` : label,
      animated: edge.source === 'lineage',
      labelShowBg: true,
      style: {
        stroke: selected === id ? 'var(--accent)' : 'var(--border-strong)',
        strokeWidth: selected === id ? 2.5 : 1 + edge.confidence,
      },
    };
  });
}

export function RelationshipsTab({
  metadata,
  onSelect,
  onSql,
}: {
  metadata: TableMetadata;
  onSelect: (ref: TableRef) => void;
  onSql: (entries: GeneratedSql[]) => void;
}) {
  const [graph, setGraph] = useState<RelationshipGraph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setGraph(null);

    apiGet<{ graph: RelationshipGraph; sql: GeneratedSql[] }>('/api/table/relationships', {
      project: metadata.ref.project,
      dataset: metadata.ref.dataset,
      table: metadata.ref.table,
    })
      .then((data) => {
        if (cancelled) return;
        setGraph(data.graph);
        onSql(data.sql);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [metadata.ref.project, metadata.ref.dataset, metadata.ref.table, onSql]);

  const nodes = useMemo(() => (graph ? layout(graph, onSelect) : []), [graph, onSelect]);
  const edges = useMemo(() => (graph ? toFlowEdges(graph, selectedEdge) : []), [graph, selectedEdge]);

  return (
    <div className="stack">
      <Panel
        title="Relationship graph"
        actions={
          <span className="faint" style={{ fontSize: 12 }}>
            Evidence-based only — shared column names alone never create an edge.
          </span>
        }
        flush
      >
        {busy ? (
          <div style={{ padding: '1rem' }}>
            <Spinner label="Gathering lineage, constraints and JOIN history…" />
          </div>
        ) : null}
        {error ? (
          <div style={{ padding: '1rem' }}>
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}

        {graph && graph.edges.length === 0 && !busy ? (
          <Empty>
            No relationships found for this table. Nothing in lineage, declared keys, recent JOIN history, or the
            curated list connects it to another table.
          </Empty>
        ) : null}

        {graph && graph.edges.length > 0 ? (
          <div className="graph-shell">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: false }}
              onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
              minZoom={0.2}
            >
              <Background gap={18} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        ) : null}
      </Panel>

      {graph && graph.warnings.length > 0 ? (
        <Notice tone="warn">
          <strong>Some evidence sources were unavailable:</strong>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
            {graph.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {graph && graph.edges.length > 0 ? (
        <Panel title="Connections" flush>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Related table</th>
                  <th>Direction</th>
                  <th>Join condition</th>
                  <th>Evidence</th>
                  <th className="num">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {graph.edges.map((edge) => {
                  const other =
                    edge.from.table === metadata.ref.table && edge.from.dataset === metadata.ref.dataset
                      ? edge.to
                      : edge.from;
                  return (
                    <tr
                      key={edge.id}
                      onClick={() => setSelectedEdge(edge.id)}
                      style={{ cursor: 'pointer', background: selectedEdge === edge.id ? 'var(--accent-soft)' : undefined }}
                    >
                      <td className="mono">
                        {other.project}.{other.dataset}.{other.table}
                      </td>
                      <td>
                        <Badge tone={edge.direction === 'upstream' ? 'good' : edge.direction === 'downstream' ? 'warn' : undefined}>
                          {edge.direction}
                        </Badge>
                      </td>
                      <td className="mono" style={{ whiteSpace: 'normal', minWidth: 260 }}>
                        {edge.conditions.length > 0 ? (
                          edge.conditions.map((condition) => <div key={condition}>{condition}</div>)
                        ) : (
                          <span className="faint">No column-level predicate recorded</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: 240 }}>
                        <Badge tone={SOURCE_TONE[edge.source]}>{SOURCE_LABEL[edge.source]}</Badge>{' '}
                        <span className="muted">{edge.evidence}</span>
                      </td>
                      <td className="num">{Math.round(edge.confidence * 100)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

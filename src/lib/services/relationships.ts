/**
 * Relationship discovery.
 *
 * Four independent evidence sources are queried in parallel and merged. Sources
 * that are unavailable (no permission on JOBS_BY_PROJECT, no declared keys)
 * degrade into a warning rather than failing the request — but nothing is ever
 * inferred from column names alone.
 */

import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { runQuery, toPlainRows } from '../bigquery';
import { parseRef, refToString } from '../identifiers';
import { parseJoins } from '../joinParser';
import { jobLineageSql, joinHistorySql } from '../sql/lineage';
import { bindTable, keyConstraintsSql } from '../sql/introspection';
import { buildGraph, sameRef, type RawEdge } from '../relationships';
import type { GeneratedSql, RelationshipGraph, TableRef } from '../types';

interface ManualRelationship {
  from: string;
  to: string;
  direction?: 'upstream' | 'downstream' | 'peer';
  columns: Array<{ from: string; to: string }>;
  note?: string;
}

let manualCache: ManualRelationship[] | null = null;

/** Curated relationships live in a read-only JSON file mounted next to the app. */
export async function loadManualRelationships(): Promise<ManualRelationship[]> {
  if (manualCache) return manualCache;
  const file =
    process.env.MANUAL_RELATIONSHIPS_PATH ?? path.join(process.cwd(), 'config', 'manual-relationships.json');
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { relationships?: ManualRelationship[] };
    manualCache = Array.isArray(parsed.relationships) ? parsed.relationships : [];
  } catch {
    manualCache = [];
  }
  return manualCache;
}

function manualEdges(root: TableRef, entries: ManualRelationship[]): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const entry of entries) {
    let from: TableRef;
    let to: TableRef;
    try {
      from = parseRef(entry.from);
      to = parseRef(entry.to);
    } catch {
      continue; // a malformed curated entry must not break discovery
    }
    if (!sameRef(from, root) && !sameRef(to, root)) continue;
    edges.push({
      from,
      to,
      direction: entry.direction ?? 'peer',
      source: 'manual',
      columnPairs: entry.columns.map((c) => ({ fromColumn: c.from, toColumn: c.to })),
      evidence: entry.note ? `Manually confirmed — ${entry.note}` : 'Manually confirmed relationship',
    });
  }
  return edges;
}

async function lineageEdges(root: TableRef, warnings: string[]): Promise<RawEdge[]> {
  const query = jobLineageSql(root);
  try {
    const { rows } = await runQuery<Record<string, unknown>>({ ...query, mock: { ref: root } });
    return toPlainRows<Record<string, unknown>>(rows).map((r) => {
      const from: TableRef = {
        project: String(r.src_project),
        dataset: String(r.src_dataset),
        table: String(r.src_table),
      };
      const to: TableRef = {
        project: String(r.dst_project),
        dataset: String(r.dst_dataset),
        table: String(r.dst_table),
      };
      const observations = Number(r.observations ?? 0);
      // The root is downstream of `from` and upstream of `to`.
      const direction = sameRef(to, root) ? 'upstream' : 'downstream';
      return {
        from,
        to,
        direction,
        source: 'lineage' as const,
        columnPairs: [],
        evidence: `${observations} job${observations === 1 ? '' : 's'} in the last ${config.joinHistoryDays} days read ${from.table} and wrote ${to.table}`,
        observations,
      };
    });
  } catch (error) {
    warnings.push(
      `Lineage unavailable: ${(error as Error).message}. Grant roles/bigquery.resourceViewer to read INFORMATION_SCHEMA.JOBS_BY_PROJECT.`,
    );
    return [];
  }
}

async function constraintEdges(root: TableRef, warnings: string[]): Promise<RawEdge[]> {
  const query = bindTable(keyConstraintsSql(root.project, root.dataset), root.table);
  try {
    const { rows } = await runQuery<Record<string, unknown>>({ ...query, mock: { ref: root } });
    const grouped = new Map<string, RawEdge>();

    for (const r of toPlainRows<Record<string, unknown>>(rows)) {
      const constraintType = String(r.constraint_type ?? '');
      const column = r.column_name ? String(r.column_name) : null;
      const refColumn = r.ref_column ? String(r.ref_column) : null;
      if (!column || !refColumn) continue;

      const owner: TableRef = { project: root.project, dataset: root.dataset, table: String(r.table_name) };
      const target: TableRef = {
        project: String(r.ref_project ?? root.project),
        dataset: String(r.ref_dataset ?? root.dataset),
        table: String(r.ref_table),
      };
      if (sameRef(owner, target)) continue;

      const key = String(r.constraint_name);
      const existing = grouped.get(key);
      if (existing) {
        existing.columnPairs.push({ fromColumn: column, toColumn: refColumn });
        continue;
      }
      grouped.set(key, {
        from: owner,
        to: target,
        direction: 'peer',
        source: constraintType === 'PRIMARY KEY' ? 'primary_key' : 'foreign_key',
        columnPairs: [{ fromColumn: column, toColumn: refColumn }],
        evidence: `Declared ${constraintType} constraint "${key}"`,
      });
    }
    return [...grouped.values()];
  } catch (error) {
    warnings.push(`Key constraints unavailable: ${(error as Error).message}`);
    return [];
  }
}

async function joinHistoryEdges(root: TableRef, warnings: string[]): Promise<RawEdge[]> {
  const query = joinHistorySql(root);
  try {
    const { rows } = await runQuery<Record<string, unknown>>({ ...query, mock: { ref: root } });
    const edges = new Map<string, RawEdge>();

    for (const r of toPlainRows<Record<string, unknown>>(rows)) {
      const sql = String(r.query ?? '');
      const observations = Number(r.observations ?? 1);
      for (const condition of parseJoins(sql)) {
        // Only predicates that actually touch the selected table are relevant.
        const touchesRoot = sameRef(condition.left.table, root) || sameRef(condition.right.table, root);
        if (!touchesRoot) continue;

        const from = sameRef(condition.left.table, root) ? condition.left : condition.right;
        const to = sameRef(condition.left.table, root) ? condition.right : condition.left;
        const key = `${refToString(from.table)}::${refToString(to.table)}::${from.column}=${to.column}`;
        const existing = edges.get(key);
        if (existing) {
          existing.observations = (existing.observations ?? 0) + observations;
          continue;
        }
        edges.set(key, {
          from: from.table,
          to: to.table,
          direction: 'peer',
          source: 'join_history',
          columnPairs: [{ fromColumn: from.column, toColumn: to.column }],
          evidence: `Observed in ${observations} quer${observations === 1 ? 'y' : 'ies'} over the last ${config.joinHistoryDays} days`,
          observations,
        });
      }
    }
    return [...edges.values()];
  } catch (error) {
    warnings.push(
      `JOIN history unavailable: ${(error as Error).message}. This source needs read access to INFORMATION_SCHEMA.JOBS_BY_PROJECT.`,
    );
    return [];
  }
}

export async function getRelationships(
  root: TableRef,
): Promise<{ graph: RelationshipGraph; sql: GeneratedSql[] }> {
  const warnings: string[] = [];
  const [lineage, constraints, joins, manual] = await Promise.all([
    lineageEdges(root, warnings),
    constraintEdges(root, warnings),
    joinHistoryEdges(root, warnings),
    loadManualRelationships().then((entries) => manualEdges(root, entries)),
  ]);

  const graph = buildGraph(root, [...manual, ...constraints, ...lineage, ...joins], warnings);

  return {
    graph,
    sql: [jobLineageSql(root), bindTable(keyConstraintsSql(root.project, root.dataset), root.table), joinHistorySql(root)],
  };
}

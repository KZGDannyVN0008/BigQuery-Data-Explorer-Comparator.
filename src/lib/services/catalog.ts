/**
 * Catalogue services: projects, datasets, tables, and full table metadata.
 * `validateTableRef` is the gate every other service calls before touching data.
 */

import 'server-only';
import { config } from '../config';
import { runQuery, toPlainRows } from '../bigquery';
import { InvalidIdentifierError, assertDataset, assertProject, assertTableRef } from '../identifiers';
import {
  columnsSql,
  listDatasetsSql,
  listTablesSql,
  partitionsSql,
  tableExistsSql,
  tableOptionsSql,
  tableStorageSql,
} from '../sql/introspection';
import type { ColumnSchema, PartitionInfo, TableMetadata, TableRef } from '../types';

export interface DatasetSummary {
  dataset: string;
  location: string | null;
}

export interface TableSummary {
  table: string;
  tableType: string;
  description: string | null;
}

export function listProjects(): string[] {
  return [...config.allowedProjects];
}

export async function listDatasets(project: string): Promise<DatasetSummary[]> {
  const p = assertProject(project);
  const query = listDatasetsSql(p);
  const { rows } = await runQuery<{ dataset: string; location: string | null }>({
    ...query,
    mock: { project: p },
  });
  return toPlainRows<{ dataset: string; location: string | null }>(rows).map((r) => ({
    dataset: r.dataset,
    location: r.location ?? null,
  }));
}

export async function listTables(project: string, dataset: string): Promise<TableSummary[]> {
  const p = assertProject(project);
  const d = assertDataset(dataset);
  const query = listTablesSql(p, d);
  const { rows } = await runQuery<Record<string, unknown>>({ ...query, mock: { project: p, dataset: d } });
  return toPlainRows<Record<string, unknown>>(rows).map((r) => ({
    table: String(r.table),
    tableType: String(r.table_type ?? 'BASE TABLE'),
    description: (r.description as string | null) ?? null,
  }));
}

/**
 * Confirms a table exists via INFORMATION_SCHEMA before any query is built
 * against it. A name that never appears here is never interpolated into SQL.
 */
export async function validateTableRef(input: unknown): Promise<TableRef> {
  const ref = assertTableRef(input);
  const query = tableExistsSql(ref);
  const { rows } = await runQuery<{ table_name: string }>({ ...query, mock: { ref } });
  if (rows.length === 0) {
    throw new InvalidIdentifierError(
      `Table ${ref.project}.${ref.dataset}.${ref.table} does not exist or is not visible to this service account.`,
    );
  }
  return ref;
}

function parseLabels(optionValue: string | null): Record<string, string> {
  if (!optionValue) return {};
  const labels: Record<string, string> = {};
  // Real BigQuery renders labels as [STRUCT("k", "v"), ...]; the mock uses JSON.
  try {
    const parsed = JSON.parse(optionValue);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && entry.length === 2) labels[String(entry[0])] = String(entry[1]);
      }
      return labels;
    }
  } catch {
    // fall through to the STRUCT(...) form
  }
  for (const match of optionValue.matchAll(/STRUCT\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g)) {
    labels[match[1]] = match[2];
  }
  return labels;
}

export async function getTableMetadata(input: unknown): Promise<TableMetadata> {
  const ref = await validateTableRef(input);

  const [columnRows, storageRows, optionRows, partitionRows] = await Promise.all([
    runQuery<Record<string, unknown>>({ ...columnsSql(ref), mock: { ref } }),
    runQuery<Record<string, unknown>>({ ...tableStorageSql(ref), mock: { ref } }),
    runQuery<Record<string, unknown>>({ ...tableOptionsSql(ref), mock: { ref } }),
    runQuery<Record<string, unknown>>({ ...partitionsSql(ref), mock: { ref } }).catch(() => ({ rows: [] })),
  ]);

  const columns: ColumnSchema[] = toPlainRows<Record<string, unknown>>(columnRows.rows).map((r) => ({
    name: String(r.column_name),
    type: String(r.data_type),
    mode:
      String(r.is_nullable).toUpperCase() === 'NO'
        ? 'REQUIRED'
        : String(r.data_type).toUpperCase().startsWith('ARRAY')
          ? 'REPEATED'
          : 'NULLABLE',
    description: (r.description as string | null) ?? null,
    position: Number(r.ordinal_position ?? 0),
    isPartitioningColumn: String(r.is_partitioning_column ?? 'NO').toUpperCase() === 'YES',
    clusteringOrdinalPosition:
      r.clustering_ordinal_position === null || r.clustering_ordinal_position === undefined
        ? null
        : Number(r.clustering_ordinal_position),
  }));

  const storage = toPlainRows<Record<string, unknown>>(storageRows.rows)[0] ?? {};
  const options = toPlainRows<Record<string, unknown>>(optionRows.rows);
  const optionMap = new Map(options.map((o) => [String(o.option_name), o.option_value as string | null]));
  const partitionStats = toPlainRows<Record<string, unknown>>(partitionRows.rows)[0] ?? {};

  const partitionField = columns.find((c) => c.isPartitioningColumn)?.name ?? null;
  const expirationDays = optionMap.get('partition_expiration_days');

  const partition: PartitionInfo = {
    type: partitionField ? 'DAY' : null,
    field: partitionField,
    requirePartitionFilter: optionMap.get('require_partition_filter') === 'true',
    expirationMs: expirationDays ? Number(expirationDays) * 86_400_000 : null,
    clusteringFields: columns
      .filter((c) => c.clusteringOrdinalPosition !== null)
      .sort((a, b) => (a.clusteringOrdinalPosition ?? 0) - (b.clusteringOrdinalPosition ?? 0))
      .map((c) => c.name),
    oldestPartitionId: (partitionStats.oldest_partition_id as string | null) ?? null,
    newestPartitionId: (partitionStats.newest_partition_id as string | null) ?? null,
    partitionCount:
      partitionStats.partition_count === undefined || partitionStats.partition_count === null
        ? null
        : Number(partitionStats.partition_count),
  };

  return {
    ref,
    tableType: 'BASE TABLE',
    description: optionMap.get('description') ?? null,
    rowCount: Number(storage.row_count ?? 0),
    sizeBytes: Number(storage.size_bytes ?? 0),
    createdAt: (storage.creation_time as string | null) ?? null,
    lastModifiedAt: (storage.last_modified_time as string | null) ?? null,
    columns,
    partition,
    labels: parseLabels(optionMap.get('labels') ?? null),
  };
}

/** Columns for every table in a project, used by the comparison suggester. */
export async function getProjectColumns(project: string): Promise<
  Array<{ dataset: string; table: string; column: string; type: string }>
> {
  const p = assertProject(project);
  const datasets = (await listDatasets(p)).map((d) => d.dataset);
  if (datasets.length === 0) return [];
  const { projectColumnsSql } = await import('../sql/introspection');
  const query = projectColumnsSql(p, datasets);
  const { rows } = await runQuery<Record<string, unknown>>({
    ...query,
    mock: { project: p, datasets },
  });
  return toPlainRows<Record<string, unknown>>(rows).map((r) => ({
    dataset: String(r.dataset),
    table: String(r.table_name),
    column: String(r.column_name),
    type: String(r.data_type),
  }));
}

/**
 * INFORMATION_SCHEMA queries. These are the only source of truth for whether a
 * table exists and what it contains — a table name is never trusted until it has
 * been seen here.
 */

import { assertDataset, assertProject, assertTable, quoteTable } from '../identifiers';
import type { GeneratedSql, TableRef } from '../types';

export function listDatasetsSql(project: string): GeneratedSql {
  const p = assertProject(project);
  return {
    label: 'list_datasets',
    sql: `
SELECT
  schema_name AS dataset,
  location,
  creation_time,
  last_modified_time
FROM \`${p}.INFORMATION_SCHEMA.SCHEMATA\`
ORDER BY schema_name
`.trim(),
    params: {},
  };
}

export function listTablesSql(project: string, dataset: string): GeneratedSql {
  const p = assertProject(project);
  const d = assertDataset(dataset);
  return {
    label: 'list_tables',
    sql: `
SELECT
  t.table_name AS table,
  t.table_type  AS table_type,
  t.creation_time,
  o.option_value AS description
FROM \`${p}.${d}.INFORMATION_SCHEMA.TABLES\` AS t
LEFT JOIN \`${p}.${d}.INFORMATION_SCHEMA.TABLE_OPTIONS\` AS o
  ON o.table_name = t.table_name AND o.option_name = 'description'
ORDER BY t.table_name
`.trim(),
    params: {},
  };
}

/** Columns plus partition/cluster flags, in ordinal order. */
export function columnsSql(ref: TableRef): GeneratedSql {
  const p = assertProject(ref.project);
  const d = assertDataset(ref.dataset);
  assertTable(ref.table);
  return {
    label: 'columns',
    sql: `
SELECT
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.ordinal_position,
  c.is_partitioning_column,
  c.clustering_ordinal_position,
  f.description
FROM \`${p}.${d}.INFORMATION_SCHEMA.COLUMNS\` AS c
LEFT JOIN \`${p}.${d}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS\` AS f
  ON f.table_name = c.table_name AND f.field_path = c.column_name
WHERE c.table_name = @table
ORDER BY c.ordinal_position
`.trim(),
    params: { table: ref.table },
  };
}

/** Storage-level facts: row count, byte size, timestamps. Free to query. */
export function tableStorageSql(ref: TableRef): GeneratedSql {
  const p = assertProject(ref.project);
  const d = assertDataset(ref.dataset);
  assertTable(ref.table);
  return {
    label: 'table_storage',
    sql: `
SELECT
  total_rows        AS row_count,
  total_logical_bytes AS size_bytes,
  creation_time,
  storage_last_modified_time AS last_modified_time
FROM \`${p}.${d}.INFORMATION_SCHEMA.TABLE_STORAGE\`
WHERE table_name = @table
`.trim(),
    params: { table: ref.table },
  };
}

/** Table-level options carry partition expiration, partition-filter requirement, labels. */
export function tableOptionsSql(ref: TableRef): GeneratedSql {
  const p = assertProject(ref.project);
  const d = assertDataset(ref.dataset);
  assertTable(ref.table);
  return {
    label: 'table_options',
    sql: `
SELECT option_name, option_type, option_value
FROM \`${p}.${d}.INFORMATION_SCHEMA.TABLE_OPTIONS\`
WHERE table_name = @table
`.trim(),
    params: { table: ref.table },
  };
}

/** Partition inventory. Cheap: PARTITIONS is metadata, not table data. */
export function partitionsSql(ref: TableRef): GeneratedSql {
  const p = assertProject(ref.project);
  const d = assertDataset(ref.dataset);
  assertTable(ref.table);
  return {
    label: 'partitions',
    sql: `
SELECT
  COUNT(*)                                          AS partition_count,
  MIN(partition_id)                                 AS oldest_partition_id,
  MAX(partition_id)                                 AS newest_partition_id,
  ANY_VALUE(total_rows)                             AS sample_partition_rows
FROM \`${p}.${d}.INFORMATION_SCHEMA.PARTITIONS\`
WHERE table_name = @table AND partition_id IS NOT NULL
`.trim(),
    params: { table: ref.table },
  };
}

/**
 * Declared PRIMARY KEY / FOREIGN KEY constraints. BigQuery supports these as
 * unenforced metadata, which still makes them a first-class relationship signal.
 */
export function keyConstraintsSql(project: string, dataset: string): GeneratedSql {
  const p = assertProject(project);
  const d = assertDataset(dataset);
  return {
    label: 'key_constraints',
    sql: `
SELECT
  tc.constraint_name,
  tc.table_name,
  tc.constraint_type,
  kcu.column_name,
  kcu.ordinal_position,
  ccu.table_catalog AS ref_project,
  ccu.table_schema  AS ref_dataset,
  ccu.table_name    AS ref_table,
  ccu.column_name   AS ref_column
FROM \`${p}.${d}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS\` AS tc
LEFT JOIN \`${p}.${d}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE\` AS kcu
  ON kcu.constraint_name = tc.constraint_name
LEFT JOIN \`${p}.${d}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE\` AS ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.ordinal_position = kcu.ordinal_position
WHERE tc.table_name = @table OR ccu.table_name = @table
ORDER BY tc.constraint_name, kcu.ordinal_position
`.trim(),
    params: { table: '' }, // caller substitutes via bindTable()
  };
}

/** Convenience for queries whose only parameter is the table name. */
export function bindTable(query: GeneratedSql, table: string): GeneratedSql {
  return { ...query, params: { ...query.params, table: assertTable(table) } };
}

/** Existence check used by validateTableRef(). */
export function tableExistsSql(ref: TableRef): GeneratedSql {
  const p = assertProject(ref.project);
  const d = assertDataset(ref.dataset);
  assertTable(ref.table);
  return {
    label: 'table_exists',
    sql: `
SELECT table_name, table_type
FROM \`${p}.${d}.INFORMATION_SCHEMA.TABLES\`
WHERE table_name = @table
LIMIT 1
`.trim(),
    params: { table: ref.table },
  };
}

/** Used by the comparison suggester to scan candidate tables in a whole project. */
export function projectColumnsSql(project: string, datasets: string[]): GeneratedSql {
  const p = assertProject(project);
  const ds = datasets.map(assertDataset);
  if (ds.length === 0) throw new Error('At least one dataset is required');
  const unions = ds
    .map(
      (d) => `SELECT '${d}' AS dataset, table_name, column_name, data_type
FROM \`${p}.${d}.INFORMATION_SCHEMA.COLUMNS\``,
    )
    .join('\nUNION ALL\n');
  return {
    label: 'project_columns',
    sql: `${unions}\nORDER BY dataset, table_name, column_name`,
    params: {},
  };
}

/** Only referenced for display; never executed against user input. */
export function describeSql(ref: TableRef): string {
  return `SELECT * FROM ${quoteTable(ref)} LIMIT 0`;
}

/**
 * Relationship evidence queries.
 *
 * Three independent signals, none of which is "these columns share a name":
 *  1. Dataplex/BigQuery lineage — which jobs read A and wrote B.
 *  2. Declared PRIMARY KEY / FOREIGN KEY constraints.
 *  3. JOIN predicates observed in INFORMATION_SCHEMA.JOBS query history.
 * A fourth signal, manually confirmed relationships, is stored outside BigQuery.
 */

import { config } from '../config';
import { assertDataset, assertProject, assertTable } from '../identifiers';
import type { GeneratedSql, TableRef } from '../types';

/**
 * Job-level lineage: any job that referenced the table, plus the table it wrote.
 * `referenced_tables` and `destination_table` give a directed edge without
 * needing the Data Catalog lineage API.
 */
export function jobLineageSql(ref: TableRef, days = config.joinHistoryDays): GeneratedSql {
  const region = `region-${config.location.toLowerCase()}`;
  const safeDays = Math.min(Math.max(1, Math.trunc(days)), 180);
  assertProject(ref.project);
  assertDataset(ref.dataset);
  assertTable(ref.table);

  return {
    label: 'job_lineage',
    sql: `
WITH jobs AS (
  SELECT
    job_id,
    destination_table,
    referenced_tables
  FROM \`${ref.project}\`.\`${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
  WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${safeDays} DAY)
    AND job_type = 'QUERY'
    AND state = 'DONE'
    AND error_result IS NULL
    AND destination_table IS NOT NULL
    AND ARRAY_LENGTH(referenced_tables) > 0
),
edges AS (
  SELECT
    ref.project_id AS src_project,
    ref.dataset_id AS src_dataset,
    ref.table_id   AS src_table,
    destination_table.project_id AS dst_project,
    destination_table.dataset_id AS dst_dataset,
    destination_table.table_id   AS dst_table
  FROM jobs
  CROSS JOIN UNNEST(referenced_tables) AS ref
)
SELECT
  src_project, src_dataset, src_table,
  dst_project, dst_dataset, dst_table,
  COUNT(*) AS observations
FROM edges
WHERE (src_project = @project AND src_dataset = @dataset AND src_table = @table)
   OR (dst_project = @project AND dst_dataset = @dataset AND dst_table = @table)
GROUP BY 1, 2, 3, 4, 5, 6
HAVING NOT (src_project = dst_project AND src_dataset = dst_dataset AND src_table = dst_table)
ORDER BY observations DESC
LIMIT 200
`.trim(),
    params: { project: ref.project, dataset: ref.dataset, table: ref.table },
  };
}

/**
 * Raw query text of recent jobs that referenced the table. JOIN predicates are
 * extracted in TypeScript (see joinParser.ts) rather than with a SQL regex, so
 * the parser can be unit-tested against real query shapes.
 */
export function joinHistorySql(ref: TableRef, days = config.joinHistoryDays): GeneratedSql {
  const region = `region-${config.location.toLowerCase()}`;
  const safeDays = Math.min(Math.max(1, Math.trunc(days)), 180);
  assertProject(ref.project);
  assertDataset(ref.dataset);
  assertTable(ref.table);

  return {
    label: 'join_history',
    sql: `
SELECT
  ANY_VALUE(query) AS query,
  COUNT(*) AS observations,
  MAX(creation_time) AS last_seen
FROM \`${ref.project}\`.\`${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${safeDays} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
  AND error_result IS NULL
  AND statement_type IN ('SELECT', 'CREATE_TABLE_AS_SELECT', 'INSERT', 'MERGE')
  AND REGEXP_CONTAINS(UPPER(query), r'\\bJOIN\\b')
  AND EXISTS (
    SELECT 1 FROM UNNEST(referenced_tables) AS t
    WHERE t.project_id = @project AND t.dataset_id = @dataset AND t.table_id = @table
  )
GROUP BY TO_HEX(MD5(REGEXP_REPLACE(query, r'\\s+', ' ')))
ORDER BY observations DESC
LIMIT 200
`.trim(),
    params: { project: ref.project, dataset: ref.dataset, table: ref.table },
  };
}

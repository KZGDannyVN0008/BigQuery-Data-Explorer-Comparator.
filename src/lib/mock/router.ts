/**
 * Answers queries from fixtures when BQ_MOCK=1.
 *
 * Dispatch is by the query's `label`, not by parsing SQL, so the mock stays
 * honest: a service that forgets to label a query fails loudly here rather than
 * silently returning plausible-looking data.
 */

import { config } from '../config';
import { estimateUsd } from '../bigquery';
import type { RunOptions, RunResult } from '../bigquery';
import type { TableRef } from '../types';
import { MOCK_COUNTRIES, MOCK_DATASETS, MOCK_TABLES, findMockTable } from './fixtures';
import { countryOf, rowsFor } from './rows';
import { baseType, isNumeric } from '../sql/types';

class MockRouteError extends Error {
  readonly status = 500;
}

function estimate(bytes: number) {
  return {
    bytesProcessed: bytes,
    bytesBilledLimit: config.dryRunLimitBytes,
    estimatedUsd: estimateUsd(bytes),
    withinLimit: true,
  };
}

function refFrom(options: RunOptions): TableRef {
  const ref = options.mock?.ref;
  if (!ref) throw new MockRouteError(`Mock query "${options.label}" is missing its table context`);
  return ref;
}

function projectFrom(options: RunOptions): string {
  const project = (options.mock?.project as string) ?? options.mock?.ref?.project;
  if (!project) throw new MockRouteError(`Mock query "${options.label}" is missing its project context`);
  return project;
}

function inWindow(value: unknown, start?: unknown, end?: unknown): boolean {
  if (typeof start !== 'string' || typeof end !== 'string') return true;
  const date = String(value ?? '').slice(0, 10);
  return date >= start && date <= end;
}

function dateColumnOf(ref: TableRef): string {
  const table = findMockTable(ref);
  const partitionField = table?.partition.field;
  if (partitionField) return partitionField;
  const first = table?.columns.find((c) => ['DATE', 'TIMESTAMP', 'DATETIME'].includes(baseType(c.type)));
  return first?.name ?? 'created_at';
}

export async function runMockQuery<T>(options: RunOptions): Promise<RunResult<T>> {
  const rows = route(options);
  return { rows: rows as T[], estimate: estimate(rows.length * 512) };
}

function route(options: RunOptions): Array<Record<string, unknown>> {
  const params = options.params ?? {};

  switch (options.label) {
    case 'list_datasets': {
      const project = projectFrom(options);
      return (MOCK_DATASETS[project] ?? []).map((dataset) => ({
        dataset,
        location: config.location,
        creation_time: '2023-11-01T00:00:00.000Z',
        last_modified_time: '2026-09-01T00:00:00.000Z',
      }));
    }

    case 'list_tables': {
      const project = projectFrom(options);
      const dataset = options.mock?.dataset as string;
      return MOCK_TABLES.filter((t) => t.ref.project === project && t.ref.dataset === dataset).map((t) => ({
        table: t.ref.table,
        table_type: t.tableType,
        creation_time: t.createdAt,
        description: t.description,
      }));
    }

    case 'table_exists': {
      const ref = refFrom(options);
      const table = findMockTable(ref);
      return table ? [{ table_name: table.ref.table, table_type: table.tableType }] : [];
    }

    case 'columns': {
      const table = findMockTable(refFrom(options));
      if (!table) return [];
      return table.columns.map((c, i) => ({
        column_name: c.name,
        data_type: c.type,
        is_nullable: c.mode === 'REQUIRED' ? 'NO' : 'YES',
        ordinal_position: i + 1,
        is_partitioning_column: c.partition ? 'YES' : 'NO',
        clustering_ordinal_position: c.cluster ?? null,
        description: c.description ?? null,
      }));
    }

    case 'table_storage': {
      const table = findMockTable(refFrom(options));
      if (!table) return [];
      return [{
        row_count: table.rowCount,
        size_bytes: table.sizeBytes,
        creation_time: table.createdAt,
        last_modified_time: table.lastModifiedAt,
      }];
    }

    case 'table_options': {
      const table = findMockTable(refFrom(options));
      if (!table) return [];
      const out: Array<Record<string, unknown>> = [
        { option_name: 'description', option_type: 'STRING', option_value: table.description },
        {
          option_name: 'require_partition_filter',
          option_type: 'BOOL',
          option_value: String(table.partition.requirePartitionFilter),
        },
      ];
      if (table.partition.expirationMs) {
        out.push({
          option_name: 'partition_expiration_days',
          option_type: 'FLOAT64',
          option_value: String(table.partition.expirationMs / 86_400_000),
        });
      }
      out.push({
        option_name: 'labels',
        option_type: 'ARRAY<STRUCT<STRING, STRING>>',
        option_value: JSON.stringify(Object.entries(table.labels)),
      });
      return out;
    }

    case 'partitions': {
      const table = findMockTable(refFrom(options));
      if (!table) return [];
      return [{
        partition_count: table.partition.partitionCount,
        oldest_partition_id: table.partition.oldestPartitionId,
        newest_partition_id: table.partition.newestPartitionId,
        sample_partition_rows: table.partition.partitionCount
          ? Math.round(table.rowCount / table.partition.partitionCount)
          : null,
      }];
    }

    case 'key_constraints': {
      const ref = refFrom(options);
      // Only the merchant dimension declares keys in the fixture warehouse.
      if (ref.table === 'merchant_dim') {
        return [{
          constraint_name: 'merchant_dim_pk',
          table_name: 'merchant_dim',
          constraint_type: 'PRIMARY KEY',
          column_name: 'merchant',
          ordinal_position: 1,
          ref_project: ref.project,
          ref_dataset: ref.dataset,
          ref_table: 'merchant_dim',
          ref_column: 'merchant',
        }];
      }
      if (ref.dataset === 'dpp_gold_prod' || ref.table === 'deposit_transaction_consolidated') {
        return [{
          constraint_name: `${ref.table}_merchant_fk`,
          table_name: ref.table,
          constraint_type: 'FOREIGN KEY',
          column_name: 'merchant',
          ordinal_position: 1,
          ref_project: 'kz-dp-prod',
          ref_dataset: 'crm_gold_prod',
          ref_table: 'merchant_dim',
          ref_column: 'merchant',
        }];
      }
      return [];
    }

    case 'project_columns': {
      const project = projectFrom(options);
      const datasets = (options.mock?.datasets as string[]) ?? MOCK_DATASETS[project] ?? [];
      return MOCK_TABLES.filter((t) => t.ref.project === project && datasets.includes(t.ref.dataset)).flatMap((t) =>
        t.columns.map((c) => ({
          dataset: t.ref.dataset,
          table_name: t.ref.table,
          column_name: c.name,
          data_type: c.type,
        })),
      );
    }

    case 'countries':
      return MOCK_COUNTRIES.map((country) => ({ country }));

    case 'sample': {
      const ref = refFrom(options);
      const dateColumn = dateColumnOf(ref);
      const limit = Number(options.mock?.limit ?? config.sampleRowLimit);
      return rowsFor(ref)
        .filter((row) => inWindow(row[dateColumn], params.start, params.end))
        .slice(0, limit);
    }

    case 'column_stats': {
      const ref = refFrom(options);
      const columns = (options.mock?.columns as Array<{ name: string; position: number; type: string }>) ?? [];
      const dateColumn = dateColumnOf(ref);
      const data = rowsFor(ref).filter((row) => inWindow(row[dateColumn], params.start, params.end));
      const out: Record<string, unknown> = { row_count: data.length };
      for (const col of columns) {
        const alias = `c_${col.position}`;
        const values = data.map((row) => row[col.name]);
        const nonNull = values.filter((v) => v !== null && v !== undefined);
        out[`${alias}__nulls`] = values.length - nonNull.length;
        out[`${alias}__distinct`] = new Set(nonNull.map((v) => String(v))).size;
        // Match SQL semantics: MIN/MAX order numerically for numeric columns,
        // lexically otherwise. Sorting everything as text would misreport both.
        const sorted = isNumeric(col.type)
          ? [...nonNull].map(Number).sort((a, b) => a - b)
          : [...nonNull].map((v) => String(v)).sort();
        out[`${alias}__min`] = sorted.length > 0 ? String(sorted[0]) : null;
        out[`${alias}__max`] = sorted.length > 0 ? String(sorted[sorted.length - 1]) : null;
      }
      return [out];
    }

    case 'top_values': {
      const ref = refFrom(options);
      const columns = (options.mock?.columns as Array<{ name: string }>) ?? [];
      const dateColumn = dateColumnOf(ref);
      const data = rowsFor(ref).filter((row) => inWindow(row[dateColumn], params.start, params.end));
      const out: Array<Record<string, unknown>> = [];
      for (const col of columns) {
        const counts = new Map<string | null, number>();
        for (const row of data) {
          const value = row[col.name];
          const key = value === null || value === undefined ? null : String(value);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
          .slice(0, config.topValuesLimit)
          .forEach(([value, occurrences]) => {
            out.push({ column_name: col.name, value, occurrences });
          });
      }
      return out;
    }

    case 'job_lineage': {
      const ref = refFrom(options);
      return mockLineage(ref);
    }

    case 'join_history': {
      const ref = refFrom(options);
      return mockJoinHistory(ref);
    }

    default:
      throw new MockRouteError(`No mock route for query label "${options.label}"`);
  }
}

/** Directed edges that mirror a plausible ELT graph for the fixture warehouse. */
function mockLineage(ref: TableRef): Array<Record<string, unknown>> {
  const country = countryOf(ref).toLowerCase();
  const edges: Array<[TableRef, TableRef, number]> = [
    [
      { project: 'kz-kura', dataset: 'kura_staging', table: 'ph_deposit_raw' },
      { project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' },
      184,
    ],
    [
      { project: 'kz-kura', dataset: 'kura_gold', table: `${country}_deposit_v2` },
      { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: `${country}_dpp_deposit_v2_gold` },
      212,
    ],
    [
      { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: `${country}_dpp_deposit_v2_gold` },
      { project: 'kz-dp-prod', dataset: 'crm_gold_prod', table: 'deposit_transaction_consolidated' },
      365,
    ],
    [
      { project: 'kz-dp-prod', dataset: 'crm_gold_prod', table: 'merchant_dim' },
      { project: 'kz-dp-prod', dataset: 'crm_gold_prod', table: 'deposit_transaction_consolidated' },
      365,
    ],
  ];

  return edges
    .filter(
      ([src, dst]) =>
        (src.project === ref.project && src.dataset === ref.dataset && src.table === ref.table) ||
        (dst.project === ref.project && dst.dataset === ref.dataset && dst.table === ref.table),
    )
    .map(([src, dst, observations]) => ({
      src_project: src.project,
      src_dataset: src.dataset,
      src_table: src.table,
      dst_project: dst.project,
      dst_dataset: dst.dataset,
      dst_table: dst.table,
      observations,
    }));
}

/** Realistic historical queries whose JOIN predicates the parser will extract. */
function mockJoinHistory(ref: TableRef): Array<Record<string, unknown>> {
  const country = countryOf(ref).toLowerCase();
  const gold = `kz-dp-prod.dpp_gold_prod.${country}_dpp_deposit_v2_gold`;
  const kura = `kz-kura.kura_gold.${country}_deposit_v2`;

  return [
    {
      query: `
SELECT d.transaction_id, d.amount, m.merchant_name
FROM \`${gold}\` AS d
JOIN \`kz-dp-prod.crm_gold_prod.merchant_dim\` AS m
  ON d.merchant = m.merchant
WHERE d.transaction_date = CURRENT_DATE()`.trim(),
      observations: 148,
      last_seen: '2026-08-31T22:10:00.000Z',
    },
    {
      query: `
SELECT g.transaction_id, g.amount AS dp_amount, k.amount AS kura_amount
FROM \`${gold}\` AS g
FULL OUTER JOIN \`${kura}\` AS k
  ON g.transaction_id = k.transaction_id AND g.merchant = k.merchant
WHERE g.transaction_date BETWEEN '2026-08-01' AND '2026-08-31'`.trim(),
      observations: 64,
      last_seen: '2026-09-01T01:05:00.000Z',
    },
    {
      query: `
SELECT c.crm_segment, COUNT(*) AS deposits
FROM \`kz-dp-prod.crm_gold_prod.deposit_transaction_consolidated\` AS c
JOIN \`${gold}\` AS g ON c.transaction_id = g.transaction_id
GROUP BY 1`.trim(),
      observations: 31,
      last_seen: '2026-08-30T14:22:00.000Z',
    },
  ];
}


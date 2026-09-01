/**
 * Sampling and column profiling.
 *
 * A table that requires a partition filter cannot be sampled or profiled without
 * a date range — the service refuses rather than issuing a full-table scan.
 */

import 'server-only';
import { config } from '../config';
import { runQuery, toPlain, toPlainRows } from '../bigquery';
import { InvalidIdentifierError, assertColumn, assertDate } from '../identifiers';
import { columnStatsSql, sampleSql, topValuesSql, type DateFilter } from '../sql/profile';
import { isTemporal } from '../sql/types';
import type { ColumnProfile, ColumnSchema, GeneratedSql, SampleData, TableMetadata } from '../types';

/** Exact COUNT(DISTINCT) is only worth it below this row count. */
const EXACT_DISTINCT_ROW_LIMIT = 5_000_000;

export class DateFilterRequiredError extends Error {
  readonly status = 400;
  constructor(field: string) {
    super(
      `This table requires a partition filter on "${field}". Provide startDate and endDate before sampling or profiling.`,
    );
    this.name = 'DateFilterRequiredError';
  }
}

export interface ProfileWindow {
  dateColumn?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Resolves the date predicate for a table. Defaults to the partition column when
 * the caller does not name one, and enforces the table's own filter requirement.
 */
export function resolveDateFilter(meta: TableMetadata, window: ProfileWindow): DateFilter | null {
  const requested = window.dateColumn ? assertColumn(window.dateColumn) : meta.partition.field;

  if (!window.startDate || !window.endDate) {
    if (meta.partition.requirePartitionFilter && meta.partition.field) {
      throw new DateFilterRequiredError(meta.partition.field);
    }
    return null;
  }

  if (!requested) {
    throw new InvalidIdentifierError('A date column is required when a date range is supplied.');
  }
  const column = meta.columns.find((c) => c.name === requested);
  if (!column) {
    throw new InvalidIdentifierError(`Column "${requested}" does not exist on this table.`);
  }
  if (!isTemporal(column.type)) {
    throw new InvalidIdentifierError(`Column "${requested}" is ${column.type} and cannot be used as a date filter.`);
  }

  return {
    column: column.name,
    type: column.type,
    start: assertDate(window.startDate, 'startDate'),
    end: assertDate(window.endDate, 'endDate'),
  };
}

export async function getSample(
  meta: TableMetadata,
  window: ProfileWindow,
  requestedColumns?: string[],
  limit = config.sampleRowLimit,
): Promise<{ sample: SampleData; sql: GeneratedSql }> {
  const filter = resolveDateFilter(meta, window);
  const names = pickColumns(meta.columns, requestedColumns).map((c) => c.name);
  const query = sampleSql(meta.ref, names, filter, limit);

  const { rows } = await runQuery<Record<string, unknown>>({
    ...query,
    mock: { ref: meta.ref, limit },
  });
  const plain = toPlainRows<Record<string, unknown>>(rows).map((row) => {
    const picked: Record<string, unknown> = {};
    for (const name of names) picked[name] = toPlain(row[name]);
    return picked;
  });

  return {
    sample: { columns: names, rows: plain, truncated: plain.length >= limit },
    sql: query,
  };
}

function pickColumns(columns: ColumnSchema[], requested?: string[]): ColumnSchema[] {
  if (!requested || requested.length === 0) return columns;
  const wanted = new Set(requested.map(assertColumn));
  const picked = columns.filter((c) => wanted.has(c.name));
  const missing = [...wanted].filter((name) => !picked.some((c) => c.name === name));
  if (missing.length > 0) {
    throw new InvalidIdentifierError(`Unknown column(s): ${missing.join(', ')}`);
  }
  return picked;
}

/**
 * Null counts, distinct counts, min/max and top values for the requested columns.
 * Columns are opt-in because BigQuery bills per column read.
 */
export async function getColumnProfiles(
  meta: TableMetadata,
  window: ProfileWindow,
  requestedColumns: string[],
  options: { includeTopValues?: boolean } = {},
): Promise<{ profiles: ColumnProfile[]; rowCount: number; approximate: boolean; sql: GeneratedSql[] }> {
  const filter = resolveDateFilter(meta, window);
  const columns = pickColumns(meta.columns, requestedColumns);
  if (columns.length === 0) {
    throw new InvalidIdentifierError('Select at least one column to profile.');
  }

  const approximate = meta.rowCount > EXACT_DISTINCT_ROW_LIMIT;
  const statsQuery = columnStatsSql(meta.ref, columns, filter, approximate);
  const sql: GeneratedSql[] = [statsQuery];

  const statsResult = await runQuery<Record<string, unknown>>({
    ...statsQuery,
    mock: { ref: meta.ref, columns: columns.map((c) => ({ name: c.name, position: c.position, type: c.type })) },
  });
  const stats = toPlainRows<Record<string, unknown>>(statsResult.rows)[0] ?? {};
  const rowCount = Number(stats.row_count ?? 0);

  const topByColumn = new Map<string, Array<{ value: string | null; count: number; percent: number }>>();
  if (options.includeTopValues !== false) {
    const topQuery = topValuesSql(meta.ref, columns, filter);
    sql.push(topQuery);
    const topResult = await runQuery<Record<string, unknown>>({
      ...topQuery,
      mock: { ref: meta.ref, columns: columns.map((c) => ({ name: c.name })) },
    });
    for (const row of toPlainRows<Record<string, unknown>>(topResult.rows)) {
      const column = String(row.column_name);
      const list = topByColumn.get(column) ?? [];
      const count = Number(row.occurrences ?? 0);
      list.push({
        value: row.value === null || row.value === undefined ? null : String(row.value),
        count,
        percent: rowCount === 0 ? 0 : Number(((count / rowCount) * 100).toFixed(2)),
      });
      topByColumn.set(column, list);
    }
  }

  const profiles: ColumnProfile[] = columns.map((column) => {
    const alias = `c_${column.position}`;
    const nullCount = Number(stats[`${alias}__nulls`] ?? 0);
    const rawDistinct = stats[`${alias}__distinct`];
    return {
      column: column.name,
      type: column.type,
      nullCount,
      nullPercent: rowCount === 0 ? 0 : Number(((nullCount / rowCount) * 100).toFixed(2)),
      distinctCount: rawDistinct === null || rawDistinct === undefined ? -1 : Number(rawDistinct),
      min: (stats[`${alias}__min`] as string | null) ?? null,
      max: (stats[`${alias}__max`] as string | null) ?? null,
      topValues: topByColumn.get(column.name) ?? [],
    };
  });

  return { profiles, rowCount, approximate, sql };
}

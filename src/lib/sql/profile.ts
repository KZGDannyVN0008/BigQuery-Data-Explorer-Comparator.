/**
 * Profiling and sampling queries.
 *
 * Everything here is column-scoped: BigQuery bills by column bytes read, so the
 * profiler only ever touches the columns the user asked about, and always
 * applies the caller's date predicate when one is available.
 */

import { config } from '../config';
import { assertColumn, quoteColumn, quoteTable } from '../identifiers';
import type { ColumnSchema, GeneratedSql, TableRef } from '../types';
import { baseType, castToString, isOrderable, toDateExpr } from './types';

export interface DateFilter {
  column: string;
  type: string;
  start: string;
  end: string;
}

/** Builds `WHERE <date column> BETWEEN @start AND @end`, or an empty clause. */
export function dateFilterClause(
  filter: DateFilter | null,
  alias?: string,
  suffix = '',
): { clause: string; params: Record<string, unknown> } {
  if (!filter) return { clause: '', params: {} };
  const col = quoteColumn(filter.column, alias);
  const dateExpr = toDateExpr(col, filter.type);
  return {
    clause: `WHERE ${dateExpr} BETWEEN @start${suffix} AND @end${suffix}`,
    params: { [`start${suffix}`]: filter.start, [`end${suffix}`]: filter.end },
  };
}

/** Sample rows. Uses TABLESAMPLE for large tables so it never reads everything. */
export function sampleSql(
  ref: TableRef,
  columns: string[],
  filter: DateFilter | null,
  limit = config.sampleRowLimit,
): GeneratedSql {
  const cols = columns.map((c) => quoteColumn(c)).join(',\n  ');
  const { clause, params } = dateFilterClause(filter);
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), config.sampleRowLimit);
  return {
    label: 'sample',
    sql: `
SELECT
  ${cols}
FROM ${quoteTable(ref)}
${clause}
LIMIT ${safeLimit}
`.trim(),
    params,
  };
}

/**
 * Null counts, distinct counts and min/max for the requested columns in one scan.
 * Distinct counts use APPROX_COUNT_DISTINCT above `exactDistinctRowLimit` rows —
 * exact COUNT(DISTINCT) on a billion-row table is not worth the shuffle.
 */
export function columnStatsSql(
  ref: TableRef,
  columns: ColumnSchema[],
  filter: DateFilter | null,
  approximate: boolean,
): GeneratedSql {
  if (columns.length === 0) throw new Error('At least one column is required');
  const { clause, params } = dateFilterClause(filter);

  const selects: string[] = ['COUNT(*) AS row_count'];
  for (const col of columns) {
    const q = quoteColumn(col.name);
    const alias = `c_${col.position}`;
    const isRepeated = col.mode === 'REPEATED';
    const t = baseType(col.type);

    selects.push(`COUNTIF(${isRepeated ? `ARRAY_LENGTH(${q}) = 0` : `${q} IS NULL`}) AS ${alias}__nulls`);

    if (isRepeated || t === 'STRUCT' || t === 'ARRAY') {
      // Nested values are not groupable; report them as unprofilable rather than failing.
      selects.push(`CAST(NULL AS INT64) AS ${alias}__distinct`);
      selects.push(`CAST(NULL AS STRING) AS ${alias}__min`);
      selects.push(`CAST(NULL AS STRING) AS ${alias}__max`);
      continue;
    }

    selects.push(
      approximate
        ? `APPROX_COUNT_DISTINCT(${q}) AS ${alias}__distinct`
        : `COUNT(DISTINCT ${q}) AS ${alias}__distinct`,
    );

    if (isOrderable(col.type)) {
      selects.push(`${castToString(`MIN(${q})`, col.type)} AS ${alias}__min`);
      selects.push(`${castToString(`MAX(${q})`, col.type)} AS ${alias}__max`);
    } else {
      selects.push(`CAST(NULL AS STRING) AS ${alias}__min`);
      selects.push(`CAST(NULL AS STRING) AS ${alias}__max`);
    }
  }

  return {
    label: 'column_stats',
    sql: `
SELECT
  ${selects.join(',\n  ')}
FROM ${quoteTable(ref)}
${clause}
`.trim(),
    params,
  };
}

/**
 * Top-N values per column, as one job. Each column contributes a grouped subquery
 * and the results are unioned into a (column, value, count) shape.
 */
export function topValuesSql(
  ref: TableRef,
  columns: ColumnSchema[],
  filter: DateFilter | null,
  limit = config.topValuesLimit,
): GeneratedSql {
  const groupable = columns.filter(
    (c) => c.mode !== 'REPEATED' && !['STRUCT', 'ARRAY', 'GEOGRAPHY'].includes(baseType(c.type)),
  );
  if (groupable.length === 0) throw new Error('No groupable columns were requested');

  const { clause, params } = dateFilterClause(filter);
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 50);
  const table = quoteTable(ref);

  const branches = groupable.map((col) => {
    const name = assertColumn(col.name);
    const q = quoteColumn(name);
    return `
SELECT * FROM (
  SELECT
    '${name}' AS column_name,
    ${castToString(q, col.type)} AS value,
    COUNT(*) AS occurrences
  FROM ${table}
  ${clause}
  GROUP BY value
  ORDER BY occurrences DESC, value
  LIMIT ${safeLimit}
)`.trim();
  });

  return {
    label: 'top_values',
    sql: branches.join('\nUNION ALL\n'),
    params,
  };
}

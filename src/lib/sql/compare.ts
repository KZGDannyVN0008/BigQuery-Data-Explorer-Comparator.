/**
 * Comparison SQL.
 *
 * Both sides are reduced to a `__key` string built from the user-confirmed key
 * columns, deduplicated, then FULL OUTER JOINed. Every query is date-bounded on
 * both sides — the API refuses to build these without a window — and every
 * preview is LIMIT/OFFSET paginated so a mismatch set never streams to the browser.
 */

import { config } from '../config';
import { assertColumn, quoteColumn, quoteTable } from '../identifiers';
import type { ColumnSchema, GeneratedSql, TableRef } from '../types';
import { areComparableTypes, castToString, isKeyable, normalizedCompareExpr, toDateExpr } from './types';

/** Hard ceiling on value columns so a comparison cannot fan out unbounded. */
export const MAX_VALUE_COLUMNS = 30;

export interface CompareSide {
  ref: TableRef;
  dateColumn: string;
  dateColumnType: string;
}

export interface CompareSpec {
  left: CompareSide;
  right: CompareSide;
  /** Key columns, present on both sides, with their type on each side. */
  key: Array<{ name: string; leftType: string; rightType: string }>;
  /** Value columns to diff, present on both sides with comparable types. */
  values: Array<{ name: string; leftType: string; rightType: string }>;
  startDate: string;
  endDate: string;
}

export class CompareSpecError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CompareSpecError';
  }
}

/** Column alias used inside generated SQL; derived from the ordinal, never the name. */
function keyAlias(index: number) {
  return `k${index}`;
}
function valueAlias(index: number) {
  return `v${index}`;
}

/** `TO_JSON_STRING([...])` is null-safe and order-stable, unlike CONCAT. */
function keyExpr(spec: CompareSpec, side: 'left' | 'right'): string {
  const parts = spec.key.map((k) => {
    const type = side === 'left' ? k.leftType : k.rightType;
    return castToString(quoteColumn(k.name), type);
  });
  return `TO_JSON_STRING([${parts.join(', ')}])`;
}

function sideCte(spec: CompareSpec, side: 'left' | 'right'): string {
  const cfg = side === 'left' ? spec.left : spec.right;
  const dateExpr = toDateExpr(quoteColumn(cfg.dateColumn), cfg.dateColumnType);

  const selects = [`${keyExpr(spec, side)} AS __key`, `${dateExpr} AS __date`];
  spec.key.forEach((k, i) => {
    const type = side === 'left' ? k.leftType : k.rightType;
    selects.push(`${castToString(quoteColumn(k.name), type)} AS ${keyAlias(i)}`);
  });
  spec.values.forEach((v, i) => {
    const type = side === 'left' ? v.leftType : v.rightType;
    selects.push(`${normalizedCompareExpr(quoteColumn(v.name), type)} AS ${valueAlias(i)}`);
  });

  return `${side}_rows AS (
  SELECT
    ${selects.join(',\n    ')}
  FROM ${quoteTable(cfg.ref)}
  WHERE ${dateExpr} BETWEEN @start AND @end
)`;
}

/** One row per key per side, carrying the duplicate count. */
function keyedCte(side: 'left' | 'right', spec: CompareSpec): string {
  const picks = [
    ...spec.key.map((_, i) => `ANY_VALUE(${keyAlias(i)}) AS ${keyAlias(i)}`),
    ...spec.values.map((_, i) => `ANY_VALUE(${valueAlias(i)}) AS ${valueAlias(i)}`),
    'MIN(__date) AS __min_date',
  ];
  return `${side}_keys AS (
  SELECT
    __key,
    COUNT(*) AS __n,
    ${picks.join(',\n    ')}
  FROM ${side}_rows
  GROUP BY __key
)`;
}

function joinedCte(spec: CompareSpec): string {
  const cols = [
    'COALESCE(l.__key, r.__key) AS __key',
    'l.__key IS NOT NULL AS in_left',
    'r.__key IS NOT NULL AS in_right',
    'IFNULL(l.__n, 0) AS left_n',
    'IFNULL(r.__n, 0) AS right_n',
    'l.__min_date AS left_date',
    'r.__min_date AS right_date',
    ...spec.key.map((_, i) => `COALESCE(l.${keyAlias(i)}, r.${keyAlias(i)}) AS ${keyAlias(i)}`),
    ...spec.values.flatMap((_, i) => [
      `l.${valueAlias(i)} AS left_${valueAlias(i)}`,
      `r.${valueAlias(i)} AS right_${valueAlias(i)}`,
    ]),
  ];
  return `joined AS (
  SELECT
    ${cols.join(',\n    ')}
  FROM left_keys AS l
  FULL OUTER JOIN right_keys AS r
    ON l.__key = r.__key
)`;
}

function baseCtes(spec: CompareSpec): string {
  return [
    sideCte(spec, 'left'),
    sideCte(spec, 'right'),
    keyedCte('left', spec),
    keyedCte('right', spec),
    joinedCte(spec),
  ].join(',\n');
}

/** `left_v0 IS DISTINCT FROM right_v0 OR ...` — null-safe inequality. */
function anyMismatchExpr(spec: CompareSpec): string {
  if (spec.values.length === 0) return 'FALSE';
  return spec.values
    .map((_, i) => `left_${valueAlias(i)} IS DISTINCT FROM right_${valueAlias(i)}`)
    .join('\n      OR ');
}

export function validateSpec(spec: CompareSpec): void {
  if (spec.key.length === 0) {
    throw new CompareSpecError('At least one key column is required.');
  }
  for (const k of spec.key) {
    assertColumn(k.name);
    if (!isKeyable(k.leftType) || !isKeyable(k.rightType)) {
      throw new CompareSpecError(
        `Column "${k.name}" (${k.leftType} / ${k.rightType}) cannot be used as a comparison key.`,
      );
    }
    if (!areComparableTypes(k.leftType, k.rightType)) {
      throw new CompareSpecError(
        `Key column "${k.name}" has incompatible types: ${k.leftType} vs ${k.rightType}.`,
      );
    }
  }
  if (spec.values.length > MAX_VALUE_COLUMNS) {
    throw new CompareSpecError(
      `Too many value columns (${spec.values.length}). Select at most ${MAX_VALUE_COLUMNS}.`,
    );
  }
  for (const v of spec.values) {
    assertColumn(v.name);
    if (!areComparableTypes(v.leftType, v.rightType)) {
      throw new CompareSpecError(
        `Value column "${v.name}" has incompatible types: ${v.leftType} vs ${v.rightType}.`,
      );
    }
  }
  if (spec.startDate > spec.endDate) {
    throw new CompareSpecError('Start date must not be after end date.');
  }
  const days = Math.round(
    (Date.parse(`${spec.endDate}T00:00:00Z`) - Date.parse(`${spec.startDate}T00:00:00Z`)) / 86_400_000,
  ) + 1;
  if (days > config.maxCompareWindowDays) {
    throw new CompareSpecError(
      `Date window of ${days} days exceeds the ${config.maxCompareWindowDays}-day maximum.`,
    );
  }
}

function dateParams(spec: CompareSpec) {
  return { start: spec.startDate, end: spec.endDate };
}

/** Every headline number in one job. */
export function countsSql(spec: CompareSpec): GeneratedSql {
  validateSpec(spec);
  const perColumn = spec.values
    .map(
      (v, i) =>
        `COUNTIF(in_left AND in_right AND left_${valueAlias(i)} IS DISTINCT FROM right_${valueAlias(i)}) ` +
        `AS mismatch_${valueAlias(i)}`,
    )
    .join(',\n  ');

  return {
    label: 'compare_counts',
    sql: `
WITH
${baseCtes(spec)}
SELECT
  (SELECT COUNT(*) FROM left_rows)  AS left_row_count,
  (SELECT COUNT(*) FROM right_rows) AS right_row_count,
  COUNTIF(in_left AND in_right)          AS matched_keys,
  COUNTIF(in_left AND NOT in_right)      AS only_in_left,
  COUNTIF(in_right AND NOT in_left)      AS only_in_right,
  COUNTIF(left_n  > 1)                   AS duplicate_keys_left,
  COUNTIF(right_n > 1)                   AS duplicate_keys_right,
  COUNTIF(in_left AND in_right AND (
      ${anyMismatchExpr(spec)}
  )) AS value_mismatches${perColumn ? `,\n  ${perColumn}` : ''}
FROM joined
`.trim(),
    params: dateParams(spec),
  };
}

/** min/max/day-count on each side, from the date column only. */
export function dateCoverageSql(spec: CompareSpec): GeneratedSql {
  validateSpec(spec);
  const leftDate = toDateExpr(quoteColumn(spec.left.dateColumn), spec.left.dateColumnType);
  const rightDate = toDateExpr(quoteColumn(spec.right.dateColumn), spec.right.dateColumnType);
  return {
    label: 'compare_date_coverage',
    sql: `
SELECT
  'left' AS side,
  MIN(${leftDate})               AS min_date,
  MAX(${leftDate})               AS max_date,
  COUNT(DISTINCT ${leftDate})    AS day_count,
  COUNT(*)                       AS row_count
FROM ${quoteTable(spec.left.ref)}
WHERE ${leftDate} BETWEEN @start AND @end
UNION ALL
SELECT
  'right' AS side,
  MIN(${rightDate}),
  MAX(${rightDate}),
  COUNT(DISTINCT ${rightDate}),
  COUNT(*)
FROM ${quoteTable(spec.right.ref)}
WHERE ${rightDate} BETWEEN @start AND @end
`.trim(),
    params: dateParams(spec),
  };
}

/** Calendar dates present on exactly one side. */
export function missingDatesSql(spec: CompareSpec, limit = 200): GeneratedSql {
  validateSpec(spec);
  const leftDate = toDateExpr(quoteColumn(spec.left.dateColumn), spec.left.dateColumnType);
  const rightDate = toDateExpr(quoteColumn(spec.right.dateColumn), spec.right.dateColumnType);
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 1000);
  return {
    label: 'compare_missing_dates',
    sql: `
WITH
left_dates AS (
  SELECT DISTINCT ${leftDate} AS d
  FROM ${quoteTable(spec.left.ref)}
  WHERE ${leftDate} BETWEEN @start AND @end
),
right_dates AS (
  SELECT DISTINCT ${rightDate} AS d
  FROM ${quoteTable(spec.right.ref)}
  WHERE ${rightDate} BETWEEN @start AND @end
)
SELECT 'missing_in_right' AS kind, d FROM left_dates
WHERE d NOT IN (SELECT d FROM right_dates)
UNION ALL
SELECT 'missing_in_left' AS kind, d FROM right_dates
WHERE d NOT IN (SELECT d FROM left_dates)
ORDER BY kind, d
LIMIT ${safeLimit}
`.trim(),
    params: dateParams(spec),
  };
}

export interface PageOptions {
  page: number;
  pageSize: number;
}

function pagination({ page, pageSize }: PageOptions): { limit: number; offset: number } {
  const size = Math.min(Math.max(1, Math.trunc(pageSize)), config.previewMaxPageSize);
  const index = Math.max(0, Math.trunc(page));
  return { limit: size, offset: index * size };
}

/** Keys present on one side only. */
export function onlyInSideSql(spec: CompareSpec, side: 'left' | 'right', opts: PageOptions): GeneratedSql {
  validateSpec(spec);
  const { limit, offset } = pagination(opts);
  const present = side === 'left' ? 'in_left AND NOT in_right' : 'in_right AND NOT in_left';
  const dateCol = side === 'left' ? 'left_date' : 'right_date';
  const keyCols = spec.key.map((k, i) => `${keyAlias(i)} AS \`${assertColumn(k.name)}\``).join(',\n  ');
  const valueCols = spec.values
    .map(
      (v, i) =>
        `${castToString(`${side}_${valueAlias(i)}`, side === 'left' ? v.leftType : v.rightType)} AS \`${assertColumn(v.name)}\``,
    )
    .join(',\n  ');

  return {
    label: `compare_only_in_${side}`,
    sql: `
WITH
${baseCtes(spec)}
SELECT
  ${keyCols},
  ${dateCol} AS \`__date\`${valueCols ? `,\n  ${valueCols}` : ''}
FROM joined
WHERE ${present}
ORDER BY __key
LIMIT ${limit} OFFSET ${offset}
`.trim(),
    params: dateParams(spec),
  };
}

/** Keys appearing more than once on either side. */
export function duplicateKeysSql(spec: CompareSpec, opts: PageOptions): GeneratedSql {
  validateSpec(spec);
  const { limit, offset } = pagination(opts);
  const keyCols = spec.key.map((k, i) => `${keyAlias(i)} AS \`${assertColumn(k.name)}\``).join(',\n  ');
  return {
    label: 'compare_duplicate_keys',
    sql: `
WITH
${baseCtes(spec)}
SELECT
  ${keyCols},
  left_n  AS \`left_occurrences\`,
  right_n AS \`right_occurrences\`
FROM joined
WHERE left_n > 1 OR right_n > 1
ORDER BY GREATEST(left_n, right_n) DESC, __key
LIMIT ${limit} OFFSET ${offset}
`.trim(),
    params: dateParams(spec),
  };
}

/**
 * Matched keys whose values differ, unpivoted to one row per differing column so
 * the preview stays readable regardless of how many columns were compared.
 */
export function valueMismatchesSql(spec: CompareSpec, opts: PageOptions): GeneratedSql {
  validateSpec(spec);
  if (spec.values.length === 0) {
    throw new CompareSpecError('No comparable value columns were selected.');
  }
  const { limit, offset } = pagination(opts);
  const keyCols = spec.key.map((k, i) => `${keyAlias(i)} AS \`${assertColumn(k.name)}\``).join(',\n    ');

  const structs = spec.values
    .map(
      (v, i) =>
        `      STRUCT(
        '${assertColumn(v.name)}' AS \`column\`,
        ${castToString(`left_${valueAlias(i)}`, v.leftType)} AS \`left_value\`,
        ${castToString(`right_${valueAlias(i)}`, v.rightType)} AS \`right_value\`,
        left_${valueAlias(i)} IS DISTINCT FROM right_${valueAlias(i)} AS \`differs\`
      )`,
    )
    .join(',\n');

  return {
    label: 'compare_value_mismatches',
    sql: `
WITH
${baseCtes(spec)},
mismatched AS (
  SELECT
    __key,
    ${keyCols},
    [
${structs}
    ] AS diffs
  FROM joined
  WHERE in_left AND in_right AND (
      ${anyMismatchExpr(spec)}
  )
)
SELECT
  ${spec.key.map((k) => `\`${assertColumn(k.name)}\``).join(',\n  ')},
  diff.\`column\`      AS \`column\`,
  diff.\`left_value\`  AS \`left_value\`,
  diff.\`right_value\` AS \`right_value\`
FROM mismatched
CROSS JOIN UNNEST(diffs) AS diff
WHERE diff.\`differs\`
ORDER BY __key, diff.\`column\`
LIMIT ${limit} OFFSET ${offset}
`.trim(),
    params: dateParams(spec),
  };
}

/**
 * Table comparison across projects.
 *
 * The flow is deliberately two-step: `suggestTargets` proposes candidates and key
 * columns, and `runComparison` only executes what the user confirmed. A date
 * window is mandatory on both sides, and every result set reaches the browser
 * paginated.
 */

import 'server-only';
import { config } from '../config';
import { QueryTooExpensiveError, dryRun, runQuery, toPlainRows } from '../bigquery';
import { InvalidIdentifierError, assertDate } from '../identifiers';
import {
  CompareSpecError,
  countsSql,
  dateCoverageSql,
  duplicateKeysSql,
  missingDatesSql,
  onlyInSideSql,
  valueMismatchesSql,
  validateSpec,
  type CompareSpec,
} from '../sql/compare';
import { areComparableTypes, baseType, isKeyable, isTemporal } from '../sql/types';
import { rankCandidates, suggestKeyColumns, type CandidateColumns } from '../similarity';
import type {
  ColumnSchema,
  CompareResult,
  ComparePage,
  CostEstimate,
  GeneratedSql,
  SchemaDiff,
  TableMetadata,
  TableRef,
  TableSuggestion,
} from '../types';
import { getProjectColumns, getTableMetadata } from './catalog';

export function diffSchemas(left: TableMetadata, right: TableMetadata): SchemaDiff {
  const rightByName = new Map(right.columns.map((c) => [c.name.toLowerCase(), c]));
  const leftByName = new Map(left.columns.map((c) => [c.name.toLowerCase(), c]));

  const missingInRight: ColumnSchema[] = left.columns.filter((c) => !rightByName.has(c.name.toLowerCase()));
  const missingInLeft: ColumnSchema[] = right.columns.filter((c) => !leftByName.has(c.name.toLowerCase()));

  const typeMismatches: SchemaDiff['typeMismatches'] = [];
  const modeMismatches: SchemaDiff['modeMismatches'] = [];
  const sharedColumns: string[] = [];

  for (const column of left.columns) {
    const other = rightByName.get(column.name.toLowerCase());
    if (!other) continue;
    sharedColumns.push(column.name);
    if (baseType(column.type) !== baseType(other.type)) {
      typeMismatches.push({
        column: column.name,
        leftType: column.type,
        rightType: other.type,
        comparable: areComparableTypes(column.type, other.type),
      });
    }
    if (column.mode !== other.mode) {
      modeMismatches.push({ column: column.name, leftMode: column.mode, rightMode: other.mode });
    }
  }

  return { missingInRight, missingInLeft, typeMismatches, modeMismatches, sharedColumns };
}

export interface SuggestionResult {
  source: TableRef;
  targetProject: string;
  suggestions: TableSuggestion[];
  /** Key candidates for the highest-scoring suggestion, ranked but not chosen. */
  keyCandidates: Array<{ name: string; leftType: string; rightType: string; score: number }>;
}

/**
 * Suggests comparison targets in `targetProject` for the selected table.
 * Defaults to suggesting kz-kura tables for a kz-dp-prod selection.
 */
export async function suggestTargets(
  sourceMeta: TableMetadata,
  targetProject?: string,
): Promise<SuggestionResult> {
  const target =
    targetProject ??
    config.allowedProjects.find((p) => p !== sourceMeta.ref.project) ??
    sourceMeta.ref.project;

  const columns = await getProjectColumns(target);
  const byTable = new Map<string, CandidateColumns>();
  for (const row of columns) {
    const key = `${row.dataset}.${row.table}`;
    const entry = byTable.get(key) ?? {
      ref: { project: target, dataset: row.dataset, table: row.table },
      columns: [],
    };
    entry.columns.push({ name: row.column, type: row.type });
    byTable.set(key, entry);
  }

  const source: CandidateColumns = {
    ref: sourceMeta.ref,
    columns: sourceMeta.columns.map((c) => ({ name: c.name, type: c.type })),
  };
  const suggestions = rankCandidates(source, [...byTable.values()], { limit: 10 });

  let keyCandidates: SuggestionResult['keyCandidates'] = [];
  const best = suggestions[0];
  if (best) {
    const candidate = byTable.get(`${best.ref.dataset}.${best.ref.table}`);
    const rightTypes = new Map((candidate?.columns ?? []).map((c) => [c.name.toLowerCase(), c.type]));
    keyCandidates = suggestKeyColumns(
      sourceMeta.columns
        .filter((c) => rightTypes.has(c.name.toLowerCase()) && isKeyable(c.type))
        .map((c) => ({
          name: c.name,
          leftType: c.type,
          rightType: rightTypes.get(c.name.toLowerCase()) as string,
        }))
        .filter((c) => areComparableTypes(c.leftType, c.rightType)),
    );
  }

  return { source: sourceMeta.ref, targetProject: target, suggestions, keyCandidates };
}

export interface CompareInput {
  left: TableRef;
  right: TableRef;
  keyColumns: string[];
  leftDateColumn: string;
  rightDateColumn: string;
  startDate: string;
  endDate: string;
  valueColumns?: string[];
  page?: number;
  pageSize?: number;
}

function requireTemporal(meta: TableMetadata, column: string, side: string): ColumnSchema {
  const found = meta.columns.find((c) => c.name === column);
  if (!found) {
    throw new InvalidIdentifierError(`Date column "${column}" does not exist on the ${side} table.`);
  }
  if (!isTemporal(found.type)) {
    throw new InvalidIdentifierError(
      `Date column "${column}" on the ${side} table is ${found.type}; a DATE, DATETIME or TIMESTAMP is required.`,
    );
  }
  return found;
}

/** Builds the validated spec; throws before any query is issued if it is unsound. */
export function buildSpec(
  input: CompareInput,
  leftMeta: TableMetadata,
  rightMeta: TableMetadata,
  diff: SchemaDiff,
): CompareSpec {
  const startDate = assertDate(input.startDate, 'startDate');
  const endDate = assertDate(input.endDate, 'endDate');

  const leftDate = requireTemporal(leftMeta, input.leftDateColumn, 'left');
  const rightDate = requireTemporal(rightMeta, input.rightDateColumn, 'right');

  const leftByName = new Map(leftMeta.columns.map((c) => [c.name.toLowerCase(), c]));
  const rightByName = new Map(rightMeta.columns.map((c) => [c.name.toLowerCase(), c]));

  if (!input.keyColumns || input.keyColumns.length === 0) {
    throw new CompareSpecError('Choose at least one comparison key column.');
  }

  const key = input.keyColumns.map((name) => {
    const l = leftByName.get(name.toLowerCase());
    const r = rightByName.get(name.toLowerCase());
    if (!l || !r) {
      throw new CompareSpecError(`Key column "${name}" is not present on both tables.`);
    }
    return { name: l.name, leftType: l.type, rightType: r.type };
  });

  const keyNames = new Set(key.map((k) => k.name.toLowerCase()));
  const excluded = new Set([
    ...keyNames,
    leftDate.name.toLowerCase(),
    rightDate.name.toLowerCase(),
  ]);

  const requested = input.valueColumns?.map((c) => c.toLowerCase());
  const values = diff.sharedColumns
    .filter((name) => !excluded.has(name.toLowerCase()))
    .filter((name) => (requested ? requested.includes(name.toLowerCase()) : true))
    .map((name) => {
      const l = leftByName.get(name.toLowerCase()) as ColumnSchema;
      const r = rightByName.get(name.toLowerCase()) as ColumnSchema;
      return { name: l.name, leftType: l.type, rightType: r.type };
    })
    // Columns whose types cannot be meaningfully compared are reported in the
    // schema diff instead of producing noise in the value diff.
    .filter((c) => areComparableTypes(c.leftType, c.rightType))
    .slice(0, 30);

  const spec: CompareSpec = {
    left: { ref: leftMeta.ref, dateColumn: leftDate.name, dateColumnType: leftDate.type },
    right: { ref: rightMeta.ref, dateColumn: rightDate.name, dateColumnType: rightDate.type },
    key,
    values,
    startDate,
    endDate,
  };
  validateSpec(spec);
  return spec;
}

function emptyPage<T>(pageSize: number): ComparePage<T> {
  return { rows: [], page: 0, pageSize, total: 0, capped: false };
}

export async function runComparison(input: CompareInput): Promise<CompareResult> {
  const [leftMeta, rightMeta] = await Promise.all([
    getTableMetadata(input.left),
    getTableMetadata(input.right),
  ]);

  const diff = diffSchemas(leftMeta, rightMeta);
  const spec = buildSpec(input, leftMeta, rightMeta, diff);

  const page = Math.max(0, Math.trunc(input.page ?? 0));
  const pageSize = Math.min(
    Math.max(1, Math.trunc(input.pageSize ?? config.previewPageSize)),
    config.previewMaxPageSize,
  );
  const pageOpts = { page, pageSize };

  const sql: GeneratedSql[] = [
    countsSql(spec),
    dateCoverageSql(spec),
    missingDatesSql(spec),
    onlyInSideSql(spec, 'left', pageOpts),
    onlyInSideSql(spec, 'right', pageOpts),
    duplicateKeysSql(spec, pageOpts),
    ...(spec.values.length > 0 ? [valueMismatchesSql(spec, pageOpts)] : []),
  ];

  const request = {
    left: leftMeta.ref,
    right: rightMeta.ref,
    keyColumns: spec.key.map((k) => k.name),
    leftDateColumn: spec.left.dateColumn,
    rightDateColumn: spec.right.dateColumn,
    startDate: spec.startDate,
    endDate: spec.endDate,
    valueColumns: spec.values.map((v) => v.name),
    page,
    pageSize,
  };

  if (config.mockMode) {
    const { mockCompare } = await import('../mock/compare');
    const result = mockCompare(spec, diff, pageOpts);
    return {
      request,
      ...result,
      sql,
      costEstimate: {
        bytesProcessed: 0,
        bytesBilledLimit: config.maxBytesBilled,
        estimatedUsd: 0,
        withinLimit: true,
      },
    };
  }

  // Cost the whole plan before running any of it, so an expensive comparison is
  // refused up front rather than after three jobs have already been billed.
  const estimate = await estimatePlan(sql);
  if (!estimate.withinLimit) throw new QueryTooExpensiveError(estimate);

  const [counts, coverage, missingDates, onlyLeft, onlyRight, duplicates, mismatches] = await Promise.all([
    runQuery<Record<string, unknown>>(countsSql(spec)),
    runQuery<Record<string, unknown>>(dateCoverageSql(spec)),
    runQuery<Record<string, unknown>>(missingDatesSql(spec)),
    runQuery<Record<string, unknown>>(onlyInSideSql(spec, 'left', pageOpts)),
    runQuery<Record<string, unknown>>(onlyInSideSql(spec, 'right', pageOpts)),
    runQuery<Record<string, unknown>>(duplicateKeysSql(spec, pageOpts)),
    spec.values.length > 0
      ? runQuery<Record<string, unknown>>(valueMismatchesSql(spec, pageOpts))
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);

  const c = toPlainRows<Record<string, unknown>>(counts.rows)[0] ?? {};
  const coverageRows = toPlainRows<Record<string, unknown>>(coverage.rows);
  const leftCoverage = coverageRows.find((r) => r.side === 'left') ?? {};
  const rightCoverage = coverageRows.find((r) => r.side === 'right') ?? {};
  const dates = toPlainRows<Record<string, unknown>>(missingDates.rows);

  const num = (value: unknown) => Number(value ?? 0);
  const pageOf = (rows: unknown[], total: number): ComparePage<Record<string, unknown>> => ({
    rows: toPlainRows<Record<string, unknown>>(rows),
    page,
    pageSize,
    total: Math.min(total, config.previewMaxTotal),
    capped: total > config.previewMaxTotal,
  });

  return {
    request,
    schemaDiff: diff,
    counts: {
      leftRows: num(c.left_row_count),
      rightRows: num(c.right_row_count),
      rowCountDelta: num(c.left_row_count) - num(c.right_row_count),
      matchedKeys: num(c.matched_keys),
      onlyInLeft: num(c.only_in_left),
      onlyInRight: num(c.only_in_right),
      duplicateKeysLeft: num(c.duplicate_keys_left),
      duplicateKeysRight: num(c.duplicate_keys_right),
      valueMismatches: num(c.value_mismatches),
    },
    dateCoverage: {
      left: {
        min: (leftCoverage.min_date as string) ?? null,
        max: (leftCoverage.max_date as string) ?? null,
        days: num(leftCoverage.day_count),
      },
      right: {
        min: (rightCoverage.min_date as string) ?? null,
        max: (rightCoverage.max_date as string) ?? null,
        days: num(rightCoverage.day_count),
      },
      missingDatesInRight: dates.filter((d) => d.kind === 'missing_in_right').map((d) => String(d.d)),
      missingDatesInLeft: dates.filter((d) => d.kind === 'missing_in_left').map((d) => String(d.d)),
    },
    previews: {
      onlyInLeft: pageOf(onlyLeft.rows, num(c.only_in_left)),
      onlyInRight: pageOf(onlyRight.rows, num(c.only_in_right)),
      duplicateKeys: pageOf(
        duplicates.rows,
        num(c.duplicate_keys_left) + num(c.duplicate_keys_right),
      ),
      valueMismatches:
        spec.values.length > 0
          ? pageOf(mismatches.rows, num(c.value_mismatches))
          : emptyPage<Record<string, unknown>>(pageSize),
    },
    sql,
    costEstimate: estimate,
  };
}

/** Sum of the dry-run costs of every query in the plan. */
export async function estimatePlan(queries: GeneratedSql[]): Promise<CostEstimate> {
  const estimates = await Promise.all(queries.map((q) => dryRun({ ...q, maxBytes: config.dryRunLimitBytes })));
  const bytes = estimates.reduce((sum, e) => sum + e.bytesProcessed, 0);
  return {
    bytesProcessed: bytes,
    bytesBilledLimit: config.dryRunLimitBytes,
    estimatedUsd: estimates.reduce((sum, e) => sum + e.estimatedUsd, 0),
    withinLimit: bytes <= config.dryRunLimitBytes,
  };
}

/**
 * In-memory implementation of the comparison, used when BQ_MOCK=1.
 *
 * It mirrors the semantics of the generated SQL — same key construction, same
 * null-safe value comparison, same pagination — so the UI and the tests exercise
 * real comparison behaviour without a warehouse.
 */

import { config } from '../config';
import type { CompareSpec } from '../sql/compare';
import { baseType, isNumeric } from '../sql/types';
import type { ComparePage, CompareResult, SchemaDiff } from '../types';
import { rowsFor, type MockRow } from './rows';

function keyOf(row: MockRow, columns: string[]): string {
  return JSON.stringify(columns.map((c) => (row[c] === null || row[c] === undefined ? null : String(row[c]))));
}

function normalize(value: unknown, type: string): string | null {
  if (value === null || value === undefined) return null;
  if (isNumeric(type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(6) : String(value);
  }
  if (baseType(type) === 'STRING') return String(value).trim();
  return String(value);
}

function dateOf(row: MockRow, column: string): string {
  return String(row[column] ?? '').slice(0, 10);
}

function paginate<T>(rows: T[], page: number, pageSize: number): ComparePage<T> {
  const size = Math.min(Math.max(1, pageSize), config.previewMaxPageSize);
  const start = Math.max(0, page) * size;
  return {
    rows: rows.slice(start, start + size),
    page: Math.max(0, page),
    pageSize: size,
    total: Math.min(rows.length, config.previewMaxTotal),
    capped: rows.length > config.previewMaxTotal,
  };
}

interface Grouped {
  key: string;
  count: number;
  row: MockRow;
  date: string;
}

function group(rows: MockRow[], keyColumns: string[], dateColumn: string): Map<string, Grouped> {
  const out = new Map<string, Grouped>();
  for (const row of rows) {
    const key = keyOf(row, keyColumns);
    const existing = out.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    out.set(key, { key, count: 1, row, date: dateOf(row, dateColumn) });
  }
  return out;
}

export function mockCompare(
  spec: CompareSpec,
  schemaDiff: SchemaDiff,
  page: { page: number; pageSize: number },
): Omit<CompareResult, 'request' | 'sql' | 'costEstimate'> {
  const keyColumns = spec.key.map((k) => k.name);

  const leftRows = rowsFor(spec.left.ref).filter((row) => {
    const d = dateOf(row, spec.left.dateColumn);
    return d >= spec.startDate && d <= spec.endDate;
  });
  const rightRows = rowsFor(spec.right.ref).filter((row) => {
    const d = dateOf(row, spec.right.dateColumn);
    return d >= spec.startDate && d <= spec.endDate;
  });

  const leftKeys = group(leftRows, keyColumns, spec.left.dateColumn);
  const rightKeys = group(rightRows, keyColumns, spec.right.dateColumn);

  const onlyInLeft: Array<Record<string, unknown>> = [];
  const onlyInRight: Array<Record<string, unknown>> = [];
  const duplicates: Array<Record<string, unknown>> = [];
  const mismatches: Array<Record<string, unknown>> = [];

  let matched = 0;
  let mismatchedKeys = 0;
  let duplicateKeysLeft = 0;
  let duplicateKeysRight = 0;

  const keyFields = (row: MockRow) =>
    Object.fromEntries(keyColumns.map((c) => [c, row[c] ?? null])) as Record<string, unknown>;

  for (const [key, left] of leftKeys) {
    if (left.count > 1) duplicateKeysLeft += 1;
    const right = rightKeys.get(key);
    if (!right) {
      onlyInLeft.push({ ...keyFields(left.row), __date: left.date });
      continue;
    }
    matched += 1;
    let differs = false;
    for (const value of spec.values) {
      const l = normalize(left.row[value.name], value.leftType);
      const r = normalize(right.row[value.name], value.rightType);
      if (l === r) continue;
      differs = true;
      mismatches.push({
        ...keyFields(left.row),
        column: value.name,
        left_value: left.row[value.name] ?? null,
        right_value: right.row[value.name] ?? null,
      });
    }
    if (differs) mismatchedKeys += 1;
  }

  for (const [key, right] of rightKeys) {
    if (right.count > 1) duplicateKeysRight += 1;
    if (!leftKeys.has(key)) onlyInRight.push({ ...keyFields(right.row), __date: right.date });
  }

  for (const [key, left] of leftKeys) {
    const right = rightKeys.get(key);
    if (left.count > 1 || (right && right.count > 1)) {
      duplicates.push({
        ...keyFields(left.row),
        left_occurrences: left.count,
        right_occurrences: right?.count ?? 0,
      });
    }
  }
  for (const [key, right] of rightKeys) {
    if (leftKeys.has(key) || right.count <= 1) continue;
    duplicates.push({ ...keyFields(right.row), left_occurrences: 0, right_occurrences: right.count });
  }

  const leftDates = [...new Set(leftRows.map((r) => dateOf(r, spec.left.dateColumn)))].sort();
  const rightDates = [...new Set(rightRows.map((r) => dateOf(r, spec.right.dateColumn)))].sort();
  const rightSet = new Set(rightDates);
  const leftSet = new Set(leftDates);

  return {
    schemaDiff,
    counts: {
      leftRows: leftRows.length,
      rightRows: rightRows.length,
      rowCountDelta: leftRows.length - rightRows.length,
      matchedKeys: matched,
      onlyInLeft: onlyInLeft.length,
      onlyInRight: onlyInRight.length,
      duplicateKeysLeft,
      duplicateKeysRight,
      valueMismatches: mismatchedKeys,
    },
    dateCoverage: {
      left: { min: leftDates[0] ?? null, max: leftDates.at(-1) ?? null, days: leftDates.length },
      right: { min: rightDates[0] ?? null, max: rightDates.at(-1) ?? null, days: rightDates.length },
      missingDatesInRight: leftDates.filter((d) => !rightSet.has(d)),
      missingDatesInLeft: rightDates.filter((d) => !leftSet.has(d)),
    },
    previews: {
      onlyInLeft: paginate(onlyInLeft, page.page, page.pageSize),
      onlyInRight: paginate(onlyInRight, page.page, page.pageSize),
      duplicateKeys: paginate(duplicates, page.page, page.pageSize),
      valueMismatches: paginate(mismatches, page.page, page.pageSize),
    },
  };
}

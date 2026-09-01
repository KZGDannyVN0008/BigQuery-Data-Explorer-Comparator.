/**
 * Identifier validation and quoting.
 *
 * Nothing user-supplied ever reaches a query as raw text. Values travel as named
 * query parameters; identifiers (project/dataset/table/column) cannot be
 * parameterised by BigQuery, so they are instead:
 *   1. matched against a strict character allowlist,
 *   2. checked against the project allowlist, and
 *   3. verified to exist via INFORMATION_SCHEMA before use (see validation.ts).
 */

import { config } from './config';
import type { TableRef } from './types';

export class InvalidIdentifierError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdentifierError';
  }
}

/** GCP project ids: 6-30 chars, lowercase letter first, letters/digits/hyphens. */
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** Dataset ids: letters, digits, underscores. */
const DATASET_RE = /^[A-Za-z0-9_]{1,1024}$/;
/** Table ids: letters, digits, underscores and hyphens (partition decorators excluded). */
const TABLE_RE = /^[A-Za-z0-9_-]{1,1024}$/;
/** Column ids: must start with a letter or underscore. */
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,299}$/;

export function assertProject(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_RE.test(value)) {
    throw new InvalidIdentifierError(`Invalid project id: ${String(value)}`);
  }
  if (!config.allowedProjects.includes(value)) {
    throw new InvalidIdentifierError(
      `Project "${value}" is not in the allowlist (${config.allowedProjects.join(', ')})`,
    );
  }
  return value;
}

export function assertDataset(value: unknown): string {
  if (typeof value !== 'string' || !DATASET_RE.test(value)) {
    throw new InvalidIdentifierError(`Invalid dataset id: ${String(value)}`);
  }
  return value;
}

export function assertTable(value: unknown): string {
  if (typeof value !== 'string' || !TABLE_RE.test(value)) {
    throw new InvalidIdentifierError(`Invalid table id: ${String(value)}`);
  }
  return value;
}

export function assertColumn(value: unknown): string {
  if (typeof value !== 'string' || !COLUMN_RE.test(value)) {
    throw new InvalidIdentifierError(`Invalid column name: ${String(value)}`);
  }
  return value;
}

export function assertTableRef(value: unknown): TableRef {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    project: assertProject(v.project),
    dataset: assertDataset(v.dataset),
    table: assertTable(v.table),
  };
}

/** ISO calendar date, YYYY-MM-DD, that is also a real date. */
export function assertDate(value: unknown, label = 'date'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidIdentifierError(`Invalid ${label}: expected YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidIdentifierError(`Invalid ${label}: ${value} is not a real calendar date`);
  }
  return value;
}

/** Fully-qualified, back-tick quoted table name for embedding in generated SQL. */
export function quoteTable(ref: TableRef): string {
  const { project, dataset, table } = {
    project: assertProject(ref.project),
    dataset: assertDataset(ref.dataset),
    table: assertTable(ref.table),
  };
  return `\`${project}.${dataset}.${table}\``;
}

/** Back-tick quoted column reference, optionally prefixed with a table alias. */
export function quoteColumn(column: string, alias?: string): string {
  const safe = assertColumn(column);
  return alias ? `${alias}.\`${safe}\`` : `\`${safe}\``;
}

export function refToString(ref: TableRef): string {
  return `${ref.project}.${ref.dataset}.${ref.table}`;
}

export function parseRef(value: string): TableRef {
  const parts = value.replace(/`/g, '').split('.');
  if (parts.length !== 3) {
    throw new InvalidIdentifierError(`Expected project.dataset.table, got "${value}"`);
  }
  return assertTableRef({ project: parts[0], dataset: parts[1], table: parts[2] });
}

/** Two-letter ISO country code used by the country shortcut. */
export function assertCountry(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) {
    throw new InvalidIdentifierError(`Invalid country code: ${String(value)}`);
  }
  return value.toUpperCase();
}

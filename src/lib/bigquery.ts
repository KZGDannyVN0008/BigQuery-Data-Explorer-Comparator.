/**
 * The single choke point for every BigQuery call.
 *
 * Guarantees enforced here:
 *  - queries are read-only (SELECT/WITH only, no DDL/DML/scripting),
 *  - every query is dry-run costed first and refused above the byte budget,
 *  - `maximumBytesBilled` caps spend even if the dry run under-estimates,
 *  - values are always bound as named parameters,
 *  - credentials come from Application Default Credentials and never leave the server.
 */

import 'server-only';
import { BigQuery, type Query } from '@google-cloud/bigquery';
import { config } from './config';
import type { CostEstimate, TableRef } from './types';

export class QueryTooExpensiveError extends Error {
  readonly status = 413;
  constructor(readonly estimate: CostEstimate) {
    super(
      `Query would scan ${formatBytes(estimate.bytesProcessed)}, above the ` +
        `${formatBytes(estimate.bytesBilledLimit)} limit. Narrow the date range or select fewer columns.`,
    );
    this.name = 'QueryTooExpensiveError';
  }
}

export class UnsafeQueryError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeQueryError';
  }
}

let client: BigQuery | null = null;

/** Lazily constructed so that importing this module never touches credentials. */
export function getClient(): BigQuery {
  if (!client) {
    client = new BigQuery({
      // Application Default Credentials: GOOGLE_APPLICATION_CREDENTIALS locally,
      // the attached service account on Cloud Run. No key material in code.
      projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined,
      location: config.location,
      autoRetry: true,
      maxRetries: 3,
    });
  }
  return client;
}

/** Statements that must never appear, even inside generated SQL. */
const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'CREATE', 'ALTER',
  'GRANT', 'REVOKE', 'CALL', 'EXPORT', 'LOAD', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'EXECUTE IMMEDIATE', 'ASSERT', 'DECLARE', 'SET ',
];

/**
 * Strips comments, string literals and back-quoted identifiers so the keyword
 * checks below cannot be fooled by data — and, just as importantly, cannot fire
 * on a column that happens to be named `update` or `load`.
 */
export function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'''[\s\S]*?'''/g, "''")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '`id`');
}

/** Defense in depth: all SQL is generated internally, but it is still checked. */
export function assertReadOnly(sql: string): void {
  const bare = stripLiteralsAndComments(sql);
  const normalized = bare.replace(/\s+/g, ' ').trim().toUpperCase();

  if (!/^(SELECT|WITH)\b/.test(normalized)) {
    throw new UnsafeQueryError('Only SELECT and WITH statements are permitted.');
  }
  for (const keyword of FORBIDDEN) {
    const pattern = new RegExp(`(^|[^A-Z_])${keyword.trim().replace(/ /g, '\\s+')}\\b`);
    if (pattern.test(normalized)) {
      throw new UnsafeQueryError(`Statement "${keyword.trim()}" is not permitted in read-only mode.`);
    }
  }
  // A single statement only; a trailing semicolon is tolerated.
  if (bare.replace(/;\s*$/, '').includes(';')) {
    throw new UnsafeQueryError('Multiple statements are not permitted.');
  }
}

export function estimateUsd(bytes: number): number {
  return (bytes / 1024 ** 4) * config.usdPerTib;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 2 : 0)} ${units[unit]}`;
}

export interface RunOptions {
  /** Identifies the query for logging and for the mock router. */
  label: string;
  sql: string;
  params?: Record<string, unknown>;
  /** Explicit BigQuery parameter types where inference is ambiguous (e.g. empty arrays). */
  types?: Record<string, unknown>;
  location?: string;
  /** Overrides the global byte budget for this query only. */
  maxBytes?: number;
  /**
   * Context handed to the mock router when BQ_MOCK=1 so it can answer without
   * re-parsing the SQL. Ignored entirely when talking to real BigQuery.
   */
  mock?: { ref?: TableRef; refs?: TableRef[]; [key: string]: unknown };
}

export interface RunResult<T> {
  rows: T[];
  estimate: CostEstimate;
}

/** Dry-runs a query and returns its cost without executing it. */
export async function dryRun(options: RunOptions): Promise<CostEstimate> {
  assertReadOnly(options.sql);
  const limit = options.maxBytes ?? config.dryRunLimitBytes;

  const [job] = await getClient().createQueryJob({
    query: options.sql,
    params: options.params,
    types: options.types,
    location: options.location ?? config.location,
    dryRun: true,
    useLegacySql: false,
  } as Query);

  const bytes = Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
  return {
    bytesProcessed: bytes,
    bytesBilledLimit: limit,
    estimatedUsd: estimateUsd(bytes),
    withinLimit: bytes <= limit,
  };
}

/**
 * Runs a read-only query after a mandatory dry-run cost check.
 * In mock mode the query is never sent; the mock router answers by label.
 */
export async function runQuery<T = Record<string, unknown>>(
  options: RunOptions,
): Promise<RunResult<T>> {
  assertReadOnly(options.sql);

  if (config.mockMode) {
    const { runMockQuery } = await import('./mock/router');
    return runMockQuery<T>(options);
  }

  const estimate = await dryRun(options);
  if (!estimate.withinLimit) {
    throw new QueryTooExpensiveError(estimate);
  }

  const [rows] = await getClient().query({
    query: options.sql,
    params: options.params,
    types: options.types,
    location: options.location ?? config.location,
    useLegacySql: false,
    maximumBytesBilled: String(options.maxBytes ?? config.maxBytesBilled),
    jobTimeoutMs: config.queryTimeoutMs,
    labels: { app: 'bq-data-explorer' },
  } as Query);

  return { rows: rows as T[], estimate };
}

/** Normalises BigQuery's wrapper objects (BigQueryDate, Big, Buffer) into JSON-safe values. */
export function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `base64:${value.toString('base64')}`;
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // BigQueryDate / BigQueryTimestamp / BigQueryDatetime all expose `value`.
    if ('value' in obj && Object.keys(obj).length === 1) return toPlain(obj.value);
    if (typeof (obj as { toString?: () => string }).toString === 'function' && obj.constructor?.name === 'Big') {
      return String(obj);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = toPlain(v);
    return out;
  }
  return value;
}

export function toPlainRows<T = Record<string, unknown>>(rows: unknown[]): T[] {
  return rows.map((row) => toPlain(row) as T);
}

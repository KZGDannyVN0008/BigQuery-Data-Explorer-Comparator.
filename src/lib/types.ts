/** Shared domain types for the BigQuery Data Explorer & Comparator. */

export interface TableRef {
  project: string;
  dataset: string;
  table: string;
}

export interface ColumnSchema {
  name: string;
  /** BigQuery standard SQL type, e.g. STRING, INT64, TIMESTAMP, NUMERIC. */
  type: string;
  mode: 'NULLABLE' | 'REQUIRED' | 'REPEATED';
  description: string | null;
  /** Ordinal position, 1-based, as reported by INFORMATION_SCHEMA. */
  position: number;
  isPartitioningColumn: boolean;
  clusteringOrdinalPosition: number | null;
}

export interface PartitionInfo {
  /** e.g. 'DAY' | 'HOUR' | 'MONTH' | 'YEAR' | 'RANGE' | null when unpartitioned. */
  type: string | null;
  field: string | null;
  requirePartitionFilter: boolean;
  expirationMs: number | null;
  clusteringFields: string[];
  /** Oldest / newest partition ids present, when cheaply available. */
  oldestPartitionId: string | null;
  newestPartitionId: string | null;
  partitionCount: number | null;
}

export interface TableMetadata {
  ref: TableRef;
  /** BASE TABLE | VIEW | MATERIALIZED VIEW | EXTERNAL | SNAPSHOT */
  tableType: string;
  description: string | null;
  rowCount: number;
  sizeBytes: number;
  createdAt: string | null;
  lastModifiedAt: string | null;
  columns: ColumnSchema[];
  partition: PartitionInfo;
  labels: Record<string, string>;
}

export interface ColumnProfile {
  column: string;
  type: string;
  nullCount: number;
  nullPercent: number;
  distinctCount: number;
  min: string | null;
  max: string | null;
  topValues: Array<{ value: string | null; count: number; percent: number }>;
}

export interface SampleData {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

export type RelationshipSource =
  | 'lineage'
  | 'primary_key'
  | 'foreign_key'
  | 'join_history'
  | 'manual';

/**
 * Always expressed relative to the graph root: `upstream` means the *other*
 * table feeds the root, `downstream` means the root feeds it. It is independent
 * of an edge's own from/to orientation.
 */
export type RelationshipDirection = 'upstream' | 'downstream' | 'peer';

export interface RelationshipEdge {
  id: string;
  from: TableRef;
  to: TableRef;
  direction: RelationshipDirection;
  source: RelationshipSource;
  /** Human readable predicates, e.g. "table_a.merchant = table_b.merchant". */
  conditions: string[];
  /** Column pairs backing the conditions. */
  columnPairs: Array<{ fromColumn: string; toColumn: string }>;
  /** 0..1. Evidence strength; name-only matches are never emitted. */
  confidence: number;
  /** Where the evidence came from, shown in the UI. */
  evidence: string;
  /** How many times a JOIN predicate was observed in query history. */
  observations?: number;
}

export interface RelationshipGraph {
  root: TableRef;
  nodes: Array<{ ref: TableRef; direction: RelationshipDirection | 'root' }>;
  edges: RelationshipEdge[];
  /** Sources that were unavailable (missing permission, region, etc.). */
  warnings: string[];
}

export interface TableSuggestion {
  ref: TableRef;
  score: number;
  reasons: string[];
  nameSimilarity: number;
  countryPrefix: string | null;
  columnOverlap: number;
  typeMatchRatio: number;
  sharedColumns: string[];
}

export interface CompareRequest {
  left: TableRef;
  right: TableRef;
  /** One or more columns forming the comparison key. */
  keyColumns: string[];
  /** Column used for the mandatory date filter on each side. */
  leftDateColumn: string;
  rightDateColumn: string;
  startDate: string;
  endDate: string;
  /** Columns to value-compare. Empty means every shared, comparable column. */
  valueColumns?: string[];
  page?: number;
  pageSize?: number;
}

export interface SchemaDiff {
  missingInRight: ColumnSchema[];
  missingInLeft: ColumnSchema[];
  typeMismatches: Array<{ column: string; leftType: string; rightType: string; comparable: boolean }>;
  modeMismatches: Array<{ column: string; leftMode: string; rightMode: string }>;
  sharedColumns: string[];
}

export interface ComparePage<T> {
  rows: T[];
  page: number;
  pageSize: number;
  /** Total is capped by PREVIEW_MAX; `capped` says whether the count hit the cap. */
  total: number;
  capped: boolean;
}

export interface CompareResult {
  request: CompareRequest;
  schemaDiff: SchemaDiff;
  counts: {
    leftRows: number;
    rightRows: number;
    rowCountDelta: number;
    matchedKeys: number;
    onlyInLeft: number;
    onlyInRight: number;
    duplicateKeysLeft: number;
    duplicateKeysRight: number;
    valueMismatches: number;
  };
  dateCoverage: {
    left: { min: string | null; max: string | null; days: number };
    right: { min: string | null; max: string | null; days: number };
    /** Dates present on one side only, capped for display. */
    missingDatesInLeft: string[];
    missingDatesInRight: string[];
  };
  previews: {
    onlyInLeft: ComparePage<Record<string, unknown>>;
    onlyInRight: ComparePage<Record<string, unknown>>;
    duplicateKeys: ComparePage<Record<string, unknown>>;
    valueMismatches: ComparePage<Record<string, unknown>>;
  };
  sql: GeneratedSql[];
  costEstimate: CostEstimate;
}

export interface GeneratedSql {
  label: string;
  sql: string;
  /** Named query parameters bound at execution time; never string-interpolated. */
  params: Record<string, unknown>;
}

export interface CostEstimate {
  bytesProcessed: number;
  bytesBilledLimit: number;
  estimatedUsd: number;
  withinLimit: boolean;
}

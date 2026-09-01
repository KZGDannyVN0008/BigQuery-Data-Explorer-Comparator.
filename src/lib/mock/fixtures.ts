/**
 * Deterministic fixtures used when BQ_MOCK=1.
 *
 * The catalogue mirrors the real warehouse shape closely enough that every
 * feature — profiling, lineage, suggestions, comparison — can be exercised
 * without credentials, in tests and in a local demo.
 */

import type { ColumnSchema, PartitionInfo, TableRef } from '../types';

export interface MockColumn {
  name: string;
  type: string;
  mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED';
  description?: string;
  partition?: boolean;
  cluster?: number;
}

export interface MockTable {
  ref: TableRef;
  tableType: string;
  description: string;
  rowCount: number;
  sizeBytes: number;
  createdAt: string;
  lastModifiedAt: string;
  columns: MockColumn[];
  partition: PartitionInfo;
  labels: Record<string, string>;
}

const DEPOSIT_COLUMNS: MockColumn[] = [
  { name: 'transaction_id', type: 'STRING', mode: 'REQUIRED', description: 'Unique deposit transaction identifier', cluster: 1 },
  { name: 'merchant', type: 'STRING', description: 'Merchant code', cluster: 2 },
  { name: 'country', type: 'STRING', description: 'ISO country code' },
  { name: 'user_id', type: 'STRING', description: 'Player identifier' },
  { name: 'amount', type: 'NUMERIC', description: 'Deposit amount in local currency' },
  { name: 'currency', type: 'STRING' },
  { name: 'status', type: 'STRING', description: 'SUCCESS | PENDING | FAILED' },
  { name: 'channel', type: 'STRING', description: 'Payment channel' },
  { name: 'transaction_date', type: 'DATE', description: 'Partition column', partition: true },
  { name: 'created_at', type: 'TIMESTAMP' },
  { name: 'updated_at', type: 'TIMESTAMP' },
];

const KURA_DEPOSIT_COLUMNS: MockColumn[] = [
  { name: 'transaction_id', type: 'STRING', mode: 'REQUIRED', description: 'Deposit id from the Kura ledger', cluster: 1 },
  { name: 'merchant', type: 'STRING', cluster: 2 },
  { name: 'country', type: 'STRING' },
  { name: 'user_id', type: 'STRING' },
  { name: 'amount', type: 'FLOAT64', description: 'Deposit amount — stored as FLOAT64 in Kura' },
  { name: 'currency', type: 'STRING' },
  { name: 'status', type: 'STRING' },
  { name: 'deposit_date', type: 'DATE', partition: true },
  { name: 'created_at', type: 'TIMESTAMP' },
  { name: 'source_system', type: 'STRING', description: 'Upstream system that produced the row' },
];

function partition(field: string | null, requireFilter: boolean, cluster: string[] = []): PartitionInfo {
  return {
    type: field ? 'DAY' : null,
    field,
    requirePartitionFilter: requireFilter,
    expirationMs: field ? 1000 * 60 * 60 * 24 * 400 : null,
    clusteringFields: cluster,
    oldestPartitionId: field ? '20240101' : null,
    newestPartitionId: field ? '20260901' : null,
    partitionCount: field ? 610 : null,
  };
}

export const MOCK_TABLES: MockTable[] = [
  {
    ref: { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'ph_dpp_deposit_v2_gold' },
    tableType: 'BASE TABLE',
    description: 'Philippines deposit fact table, gold layer',
    rowCount: 184_233_910,
    sizeBytes: 41_233_887_744,
    createdAt: '2024-01-04T09:12:00.000Z',
    lastModifiedAt: '2026-09-01T04:15:22.000Z',
    columns: DEPOSIT_COLUMNS,
    partition: partition('transaction_date', true, ['transaction_id', 'merchant']),
    labels: { layer: 'gold', domain: 'deposit', country: 'ph' },
  },
  {
    ref: { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'bd_dpp_deposit_v2_gold' },
    tableType: 'BASE TABLE',
    description: 'Bangladesh deposit fact table, gold layer',
    rowCount: 52_119_004,
    sizeBytes: 12_884_901_888,
    createdAt: '2024-02-11T11:00:00.000Z',
    lastModifiedAt: '2026-09-01T04:17:02.000Z',
    columns: DEPOSIT_COLUMNS,
    partition: partition('transaction_date', true, ['transaction_id', 'merchant']),
    labels: { layer: 'gold', domain: 'deposit', country: 'bd' },
  },
  {
    ref: { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'mx_dpp_deposit_v2_gold' },
    tableType: 'BASE TABLE',
    description: 'Mexico deposit fact table, gold layer',
    rowCount: 21_004_552,
    sizeBytes: 5_368_709_120,
    createdAt: '2024-05-02T08:30:00.000Z',
    lastModifiedAt: '2026-08-31T23:50:11.000Z',
    columns: DEPOSIT_COLUMNS,
    partition: partition('transaction_date', true, ['transaction_id', 'merchant']),
    labels: { layer: 'gold', domain: 'deposit', country: 'mx' },
  },
  {
    ref: { project: 'kz-dp-prod', dataset: 'crm_gold_prod', table: 'deposit_transaction_consolidated' },
    tableType: 'BASE TABLE',
    description: 'All-country consolidated deposit transactions used by CRM',
    rowCount: 612_884_301,
    sizeBytes: 158_913_789_952,
    createdAt: '2023-11-20T10:00:00.000Z',
    lastModifiedAt: '2026-09-01T05:02:44.000Z',
    columns: [
      ...DEPOSIT_COLUMNS,
      { name: 'crm_segment', type: 'STRING', description: 'CRM lifecycle segment' },
      { name: 'is_first_deposit', type: 'BOOL' },
    ],
    partition: partition('transaction_date', true, ['country', 'merchant']),
    labels: { layer: 'gold', domain: 'crm' },
  },
  {
    ref: { project: 'kz-dp-prod', dataset: 'crm_gold_prod', table: 'merchant_dim' },
    tableType: 'BASE TABLE',
    description: 'Merchant dimension',
    rowCount: 1_842,
    sizeBytes: 1_048_576,
    createdAt: '2023-11-20T10:00:00.000Z',
    lastModifiedAt: '2026-08-30T02:00:00.000Z',
    columns: [
      { name: 'merchant', type: 'STRING', mode: 'REQUIRED', description: 'Merchant code (primary key)' },
      { name: 'merchant_name', type: 'STRING' },
      { name: 'country', type: 'STRING' },
      { name: 'is_active', type: 'BOOL' },
      { name: 'onboarded_at', type: 'TIMESTAMP' },
    ],
    partition: partition(null, false),
    labels: { layer: 'gold', domain: 'reference' },
  },
  {
    ref: { project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' },
    tableType: 'BASE TABLE',
    description: 'Kura Philippines deposit ledger',
    rowCount: 183_998_120,
    sizeBytes: 38_654_705_664,
    createdAt: '2024-01-08T07:45:00.000Z',
    lastModifiedAt: '2026-09-01T03:58:10.000Z',
    columns: KURA_DEPOSIT_COLUMNS,
    partition: partition('deposit_date', true, ['transaction_id', 'merchant']),
    labels: { layer: 'gold', system: 'kura', country: 'ph' },
  },
  {
    ref: { project: 'kz-kura', dataset: 'kura_gold', table: 'bd_deposit_v2' },
    tableType: 'BASE TABLE',
    description: 'Kura Bangladesh deposit ledger',
    rowCount: 51_884_772,
    sizeBytes: 11_811_160_064,
    createdAt: '2024-02-14T07:45:00.000Z',
    lastModifiedAt: '2026-09-01T03:59:40.000Z',
    columns: KURA_DEPOSIT_COLUMNS,
    partition: partition('deposit_date', true, ['transaction_id', 'merchant']),
    labels: { layer: 'gold', system: 'kura', country: 'bd' },
  },
  {
    ref: { project: 'kz-kura', dataset: 'kura_gold', table: 'merchant_master' },
    tableType: 'BASE TABLE',
    description: 'Kura merchant master data',
    rowCount: 1_855,
    sizeBytes: 1_179_648,
    createdAt: '2024-01-08T07:45:00.000Z',
    lastModifiedAt: '2026-08-30T01:30:00.000Z',
    columns: [
      { name: 'merchant', type: 'STRING', mode: 'REQUIRED' },
      { name: 'merchant_name', type: 'STRING' },
      { name: 'country', type: 'STRING' },
      { name: 'is_active', type: 'BOOL' },
      { name: 'created_at', type: 'TIMESTAMP' },
    ],
    partition: partition(null, false),
    labels: { layer: 'gold', system: 'kura' },
  },
  {
    ref: { project: 'kz-kura', dataset: 'kura_staging', table: 'ph_deposit_raw' },
    tableType: 'BASE TABLE',
    description: 'Raw Kura Philippines deposit events',
    rowCount: 191_442_881,
    sizeBytes: 62_277_025_792,
    createdAt: '2024-01-08T07:00:00.000Z',
    lastModifiedAt: '2026-09-01T03:40:00.000Z',
    columns: [
      { name: 'event_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'transaction_id', type: 'STRING' },
      { name: 'merchant', type: 'STRING' },
      { name: 'payload', type: 'JSON' },
      { name: 'ingested_at', type: 'TIMESTAMP', partition: true },
    ],
    partition: partition('ingested_at', true, []),
    labels: { layer: 'staging', system: 'kura' },
  },
];

export const MOCK_DATASETS: Record<string, string[]> = {
  'kz-dp-prod': ['crm_gold_prod', 'dpp_gold_prod'],
  'kz-kura': ['kura_gold', 'kura_staging'],
};

export const MOCK_COUNTRIES = ['BD', 'BR', 'CO', 'EG', 'MX', 'PE', 'PH', 'PK', 'TH'];

export function findMockTable(ref: TableRef): MockTable | undefined {
  return MOCK_TABLES.find(
    (t) => t.ref.project === ref.project && t.ref.dataset === ref.dataset && t.ref.table === ref.table,
  );
}

export function toColumnSchema(columns: MockColumn[]): ColumnSchema[] {
  return columns.map((c, index) => ({
    name: c.name,
    type: c.type,
    mode: c.mode ?? 'NULLABLE',
    description: c.description ?? null,
    position: index + 1,
    isPartitioningColumn: Boolean(c.partition),
    clusteringOrdinalPosition: c.cluster ?? null,
  }));
}

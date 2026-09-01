/**
 * Deterministic row generation for the mock warehouse.
 *
 * Differences between the two sides are planted on purpose so the comparator has
 * something real to find: rows missing from each side, duplicate keys, a type
 * difference on `amount`, value drift on `status`, and a date gap.
 */

import { findMockTable } from './fixtures';
import type { TableRef } from '../types';

/** Small, fast, fully deterministic PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = ['MKZ01', 'MKZ02', 'MKZ07', 'MKZ11', 'MKZ23', 'MKZ42'];
const CHANNELS = ['GCASH', 'MAYA', 'BANK_TRANSFER', 'USDT', 'OTC'];
const STATUSES = ['SUCCESS', 'SUCCESS', 'SUCCESS', 'PENDING', 'FAILED'];
const CURRENCY: Record<string, string> = { PH: 'PHP', BD: 'BDT', MX: 'MXN', PK: 'PKR', TH: 'THB' };

export interface MockRow {
  [key: string]: string | number | boolean | null;
}

function dateAdd(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Base ledger both sides are derived from. */
function baseLedger(country: string, seed: number, count: number, startDate: string) {
  const rand = seeded(seed);
  const rows: Array<{
    transaction_id: string;
    merchant: string;
    country: string;
    user_id: string;
    amount: number;
    currency: string;
    status: string;
    channel: string;
    date: string;
    created_at: string;
  }> = [];

  for (let i = 0; i < count; i += 1) {
    const dayOffset = Math.floor(rand() * 30);
    const date = dateAdd(startDate, dayOffset);
    rows.push({
      transaction_id: `${country}-TXN-${String(100000 + i)}`,
      merchant: MERCHANTS[Math.floor(rand() * MERCHANTS.length)],
      country,
      user_id: `U${String(Math.floor(rand() * 4000)).padStart(6, '0')}`,
      amount: Math.round(rand() * 500000) / 100,
      currency: CURRENCY[country] ?? 'USD',
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
      channel: CHANNELS[Math.floor(rand() * CHANNELS.length)],
      date,
      created_at: `${date}T${String(Math.floor(rand() * 24)).padStart(2, '0')}:30:00.000Z`,
    });
  }
  return rows;
}

export interface MockScenario {
  left: MockRow[];
  right: MockRow[];
  startDate: string;
  endDate: string;
}

const SCENARIO_START = '2026-08-01';
const SCENARIO_ROWS = 600;

/** Cached so repeated API calls in a session return identical data. */
const scenarioCache = new Map<string, MockScenario>();

/**
 * Builds the planted-difference scenario for a country.
 *  - 12 keys exist only on the dp-prod side (dropped from Kura)
 *  - 8 keys exist only on the Kura side (late arrivals)
 *  - 5 keys are duplicated on the Kura side
 *  - ~7% of matched rows have a drifted `status` or rounded `amount`
 *  - the final day is missing from the Kura side entirely
 */
export function buildScenario(country: string): MockScenario {
  const cached = scenarioCache.get(country);
  if (cached) return cached;

  const seed = [...country].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7);
  const base = baseLedger(country, seed, SCENARIO_ROWS, SCENARIO_START);
  const rand = seeded(seed + 991);
  const endDate = dateAdd(SCENARIO_START, 29);
  const lastDay = endDate;

  const left: MockRow[] = [];
  const right: MockRow[] = [];

  base.forEach((row, index) => {
    left.push({
      transaction_id: row.transaction_id,
      merchant: row.merchant,
      country: row.country,
      user_id: row.user_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      channel: row.channel,
      transaction_date: row.date,
      created_at: row.created_at,
      updated_at: row.created_at,
    });

    // 12 keys dropped from the Kura side.
    if (index % 50 === 3 && right.length < SCENARIO_ROWS) return;
    // The Kura side is missing the final day altogether.
    if (row.date === lastDay) return;

    const drift = rand();
    const kuraRow: MockRow = {
      transaction_id: row.transaction_id,
      merchant: row.merchant,
      country: row.country,
      user_id: row.user_id,
      // FLOAT64 on the Kura side; a few rows are rounded to whole units.
      amount: drift < 0.04 ? Math.round(row.amount) : row.amount,
      currency: row.currency,
      status: drift >= 0.04 && drift < 0.07 ? 'PENDING' : row.status,
      deposit_date: row.date,
      created_at: row.created_at,
      source_system: 'kura-ledger',
    };
    right.push(kuraRow);

    // 5 duplicated keys on the Kura side.
    if (index % 120 === 11) right.push({ ...kuraRow });
  });

  // 8 late arrivals that only exist on the Kura side.
  for (let i = 0; i < 8; i += 1) {
    const date = dateAdd(SCENARIO_START, 10 + i);
    right.push({
      transaction_id: `${country}-TXN-LATE-${i}`,
      merchant: MERCHANTS[i % MERCHANTS.length],
      country,
      user_id: `U${String(900000 + i)}`,
      amount: Math.round(rand() * 100000) / 100,
      currency: CURRENCY[country] ?? 'USD',
      status: 'SUCCESS',
      deposit_date: date,
      created_at: `${date}T12:00:00.000Z`,
      source_system: 'kura-ledger',
    });
  }

  const scenario: MockScenario = { left, right, startDate: SCENARIO_START, endDate };
  scenarioCache.set(country, scenario);
  return scenario;
}

/** Country code implied by a mock table, used to pick the right scenario. */
export function countryOf(ref: TableRef): string {
  const prefix = ref.table.slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(prefix) ? prefix : 'PH';
}

/** Rows backing a mock table; non-deposit tables get a small synthetic set. */
export function rowsFor(ref: TableRef): MockRow[] {
  const table = findMockTable(ref);
  if (!table) return [];
  const scenario = buildScenario(countryOf(ref));

  if (ref.project === 'kz-kura' && ref.dataset === 'kura_gold' && ref.table.endsWith('_deposit_v2')) {
    return scenario.right;
  }
  if (ref.dataset === 'dpp_gold_prod') return scenario.left;
  if (ref.table === 'deposit_transaction_consolidated') {
    return scenario.left.map((row) => ({
      ...row,
      crm_segment: ['NEW', 'ACTIVE', 'CHURN_RISK', 'VIP'][Math.abs(String(row.user_id).charCodeAt(2)) % 4],
      is_first_deposit: String(row.transaction_id).endsWith('7'),
    }));
  }
  if (table.ref.table === 'merchant_dim' || table.ref.table === 'merchant_master') {
    return MERCHANTS.map((m, i) => ({
      merchant: m,
      merchant_name: `Merchant ${m.slice(3)}`,
      country: ['PH', 'BD', 'MX', 'PH', 'TH', 'PH'][i] ?? 'PH',
      is_active: i !== 4,
      onboarded_at: `2024-0${(i % 9) + 1}-01T00:00:00.000Z`,
      created_at: `2024-0${(i % 9) + 1}-01T00:00:00.000Z`,
    }));
  }
  if (table.ref.table === 'ph_deposit_raw') {
    return scenario.right.slice(0, 120).map((row, i) => ({
      event_id: `EVT-${i}`,
      transaction_id: row.transaction_id,
      merchant: row.merchant,
      payload: JSON.stringify({ amount: row.amount, status: row.status }),
      ingested_at: `${row.deposit_date}T09:00:00.000Z`,
    }));
  }
  return scenario.left;
}

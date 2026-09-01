/**
 * End-to-end exercise of the services against the mock warehouse.
 * BQ_MOCK is set before the modules are imported so `config` picks it up.
 */

import { beforeAll, describe, expect, it } from 'vitest';

process.env.BQ_MOCK = '1';

type Services = {
  catalog: typeof import('@/lib/services/catalog');
  compare: typeof import('@/lib/services/compare');
  profile: typeof import('@/lib/services/profile');
  relationships: typeof import('@/lib/services/relationships');
  countries: typeof import('@/lib/services/countries');
};

let s: Services;

const GOLD = { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'ph_dpp_deposit_v2_gold' };
const KURA = { project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' };
const WINDOW = { startDate: '2026-08-01', endDate: '2026-08-30' };

beforeAll(async () => {
  s = {
    catalog: await import('@/lib/services/catalog'),
    compare: await import('@/lib/services/compare'),
    profile: await import('@/lib/services/profile'),
    relationships: await import('@/lib/services/relationships'),
    countries: await import('@/lib/services/countries'),
  };
});

describe('catalogue', () => {
  it('lists only allowlisted projects', () => {
    expect(s.catalog.listProjects()).toEqual(['kz-dp-prod', 'kz-kura']);
  });

  it('cascades project → dataset → table', async () => {
    const datasets = await s.catalog.listDatasets('kz-dp-prod');
    expect(datasets.map((d) => d.dataset)).toContain('dpp_gold_prod');

    const tables = await s.catalog.listTables('kz-dp-prod', 'dpp_gold_prod');
    expect(tables.map((t) => t.table)).toContain('ph_dpp_deposit_v2_gold');
  });

  it('rejects a table that INFORMATION_SCHEMA does not know about', async () => {
    await expect(
      s.catalog.validateTableRef({ ...GOLD, table: 'table_that_does_not_exist' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('assembles schema, storage and partition metadata', async () => {
    const meta = await s.catalog.getTableMetadata(GOLD);
    expect(meta.rowCount).toBeGreaterThan(0);
    expect(meta.sizeBytes).toBeGreaterThan(0);
    expect(meta.columns.map((c) => c.name)).toContain('transaction_id');
    expect(meta.partition.field).toBe('transaction_date');
    expect(meta.partition.requirePartitionFilter).toBe(true);
    expect(meta.partition.clusteringFields).toEqual(['transaction_id', 'merchant']);
    expect(meta.labels.country).toBe('ph');
  });
});

describe('profiling', () => {
  it('refuses to sample a partition-filtered table without a date range', async () => {
    const meta = await s.catalog.getTableMetadata(GOLD);
    await expect(s.profile.getSample(meta, {})).rejects.toThrow(/requires a partition filter/);
  });

  it('samples within the window and never exceeds the row cap', async () => {
    const meta = await s.catalog.getTableMetadata(GOLD);
    const { sample } = await s.profile.getSample(meta, WINDOW);
    expect(sample.rows.length).toBeGreaterThan(0);
    expect(sample.rows.length).toBeLessThanOrEqual(50);
    expect(sample.columns).toContain('amount');
  });

  it('reports nulls, distinct counts, min/max and top values', async () => {
    const meta = await s.catalog.getTableMetadata(GOLD);
    const { profiles, rowCount } = await s.profile.getColumnProfiles(meta, WINDOW, ['status', 'merchant']);
    expect(rowCount).toBeGreaterThan(0);

    const status = profiles.find((p) => p.column === 'status');
    expect(status).toBeDefined();
    expect(status!.distinctCount).toBeGreaterThan(0);
    expect(status!.topValues.length).toBeGreaterThan(0);
    expect(status!.topValues[0].count).toBeGreaterThanOrEqual(status!.topValues.at(-1)!.count);
    expect(status!.min).not.toBeNull();
  });

  it('rejects a column that is not on the table', async () => {
    const meta = await s.catalog.getTableMetadata(GOLD);
    await expect(s.profile.getColumnProfiles(meta, WINDOW, ['not_a_column'])).rejects.toThrow(/Unknown column/);
  });
});

describe('relationships', () => {
  it('finds upstream and downstream tables with column-level predicates', async () => {
    const { graph } = await s.relationships.getRelationships(GOLD);
    expect(graph.edges.length).toBeGreaterThan(0);

    const neighbours = graph.nodes.filter((n) => n.direction !== 'root').map((n) => n.ref.table);
    expect(neighbours).toContain('ph_deposit_v2');
    expect(neighbours).toContain('deposit_transaction_consolidated');

    const conditions = graph.edges.flatMap((e) => e.conditions);
    expect(conditions.some((c) => c.includes('transaction_id = '))).toBe(true);
  });

  it('never emits an edge without evidence behind it', async () => {
    const { graph } = await s.relationships.getRelationships(GOLD);
    for (const edge of graph.edges) {
      expect(edge.evidence.length).toBeGreaterThan(0);
      expect(['lineage', 'primary_key', 'foreign_key', 'join_history', 'manual']).toContain(edge.source);
    }
  });

  it('records the manually confirmed relationship at full confidence', async () => {
    const { graph } = await s.relationships.getRelationships(GOLD);
    const kuraEdge = graph.edges.find((e) => e.from.table === 'ph_deposit_v2' || e.to.table === 'ph_deposit_v2');
    expect(kuraEdge?.confidence).toBe(1);
  });
});

describe('country shortcut', () => {
  it('lists countries and maps each to its default deposit table', async () => {
    const { countries } = await s.countries.listCountries();
    expect(countries.map((c) => c.country)).toEqual(
      expect.arrayContaining(['PH', 'BD', 'MX', 'PK', 'TH', 'BR', 'EG', 'CO', 'PE']),
    );
    const ph = countries.find((c) => c.country === 'PH');
    expect(ph?.ref).toEqual({
      project: 'kz-dp-prod',
      dataset: 'dpp_gold_prod',
      table: 'ph_dpp_deposit_v2_gold',
    });
  });
});

describe('comparison', () => {
  it('suggests the Kura counterpart first', async () => {
    const meta = await s.catalog.getTableMetadata(GOLD);
    const result = await s.compare.suggestTargets(meta, 'kz-kura');
    expect(result.suggestions[0].ref.table).toBe('ph_deposit_v2');
    expect(result.keyCandidates[0].name).toBe('transaction_id');
  });

  it('diffs the schemas, including the NUMERIC/FLOAT64 drift', async () => {
    const [left, right] = await Promise.all([
      s.catalog.getTableMetadata(GOLD),
      s.catalog.getTableMetadata(KURA),
    ]);
    const diff = s.compare.diffSchemas(left, right);

    expect(diff.missingInRight.map((c) => c.name)).toEqual(
      expect.arrayContaining(['channel', 'updated_at', 'transaction_date']),
    );
    expect(diff.missingInLeft.map((c) => c.name)).toEqual(
      expect.arrayContaining(['deposit_date', 'source_system']),
    );
    const amount = diff.typeMismatches.find((m) => m.column === 'amount');
    expect(amount).toMatchObject({ leftType: 'NUMERIC', rightType: 'FLOAT64', comparable: true });
  });

  it('finds every planted difference between the two sides', async () => {
    const result = await s.compare.runComparison({
      left: GOLD,
      right: KURA,
      keyColumns: ['transaction_id'],
      leftDateColumn: 'transaction_date',
      rightDateColumn: 'deposit_date',
      startDate: WINDOW.startDate,
      endDate: WINDOW.endDate,
    });

    expect(result.counts.matchedKeys).toBeGreaterThan(0);
    expect(result.counts.onlyInLeft).toBeGreaterThan(0);
    expect(result.counts.onlyInRight).toBe(8); // the planted late arrivals
    expect(result.counts.duplicateKeysRight).toBeGreaterThan(0);
    expect(result.counts.valueMismatches).toBeGreaterThan(0);
    expect(result.counts.rowCountDelta).not.toBe(0);

    // The Kura side is missing the final day of the window.
    expect(result.dateCoverage.missingDatesInRight).toContain('2026-08-30');
    expect(result.dateCoverage.missingDatesInLeft).toHaveLength(0);
  });

  it('paginates previews rather than returning the whole diff', async () => {
    const request = {
      left: GOLD,
      right: KURA,
      keyColumns: ['transaction_id'],
      leftDateColumn: 'transaction_date',
      rightDateColumn: 'deposit_date',
      startDate: WINDOW.startDate,
      endDate: WINDOW.endDate,
      pageSize: 5,
    };
    const first = await s.compare.runComparison({ ...request, page: 0 });
    const second = await s.compare.runComparison({ ...request, page: 1 });

    expect(first.previews.onlyInLeft.rows).toHaveLength(5);
    expect(first.previews.onlyInLeft.rows).not.toEqual(second.previews.onlyInLeft.rows);
    expect(second.previews.onlyInLeft.page).toBe(1);
  });

  it('reports the generated SQL for every query in the plan', async () => {
    const result = await s.compare.runComparison({
      left: GOLD,
      right: KURA,
      keyColumns: ['transaction_id'],
      leftDateColumn: 'transaction_date',
      rightDateColumn: 'deposit_date',
      startDate: WINDOW.startDate,
      endDate: WINDOW.endDate,
    });
    expect(result.sql.map((q) => q.label)).toEqual(
      expect.arrayContaining([
        'compare_counts',
        'compare_date_coverage',
        'compare_missing_dates',
        'compare_only_in_left',
        'compare_only_in_right',
        'compare_duplicate_keys',
        'compare_value_mismatches',
      ]),
    );
  });

  it('refuses a key column that is missing from one side', async () => {
    await expect(
      s.compare.runComparison({
        left: GOLD,
        right: KURA,
        keyColumns: ['channel'],
        leftDateColumn: 'transaction_date',
        rightDateColumn: 'deposit_date',
        startDate: WINDOW.startDate,
        endDate: WINDOW.endDate,
      }),
    ).rejects.toThrow(/not present on both tables/);
  });

  it('refuses a comparison window wider than the maximum', async () => {
    await expect(
      s.compare.runComparison({
        left: GOLD,
        right: KURA,
        keyColumns: ['transaction_id'],
        leftDateColumn: 'transaction_date',
        rightDateColumn: 'deposit_date',
        startDate: '2024-01-01',
        endDate: '2026-08-30',
      }),
    ).rejects.toThrow(/exceeds the/);
  });

  it('refuses a non-temporal date column', async () => {
    await expect(
      s.compare.runComparison({
        left: GOLD,
        right: KURA,
        keyColumns: ['transaction_id'],
        leftDateColumn: 'merchant',
        rightDateColumn: 'deposit_date',
        startDate: WINDOW.startDate,
        endDate: WINDOW.endDate,
      }),
    ).rejects.toThrow(/DATE, DATETIME or TIMESTAMP is required/);
  });
});

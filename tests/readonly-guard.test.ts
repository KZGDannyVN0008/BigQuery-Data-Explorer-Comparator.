import { describe, expect, it } from 'vitest';
import { UnsafeQueryError, assertReadOnly, stripLiteralsAndComments } from '@/lib/bigquery';
import { countsSql, type CompareSpec } from '@/lib/sql/compare';
import { columnStatsSql, sampleSql, topValuesSql } from '@/lib/sql/profile';
import { jobLineageSql, joinHistorySql } from '@/lib/sql/lineage';
import { columnsSql, listDatasetsSql, listTablesSql, partitionsSql } from '@/lib/sql/introspection';
import { countriesSql } from '@/lib/services/countries';
import type { ColumnSchema, TableRef } from '@/lib/types';

const ref: TableRef = { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'ph_dpp_deposit_v2_gold' };
const right: TableRef = { project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' };

const columns: ColumnSchema[] = [
  { name: 'transaction_id', type: 'STRING', mode: 'REQUIRED', description: null, position: 1, isPartitioningColumn: false, clusteringOrdinalPosition: 1 },
  { name: 'amount', type: 'NUMERIC', mode: 'NULLABLE', description: null, position: 2, isPartitioningColumn: false, clusteringOrdinalPosition: null },
  { name: 'transaction_date', type: 'DATE', mode: 'NULLABLE', description: null, position: 3, isPartitioningColumn: true, clusteringOrdinalPosition: null },
];

const spec: CompareSpec = {
  left: { ref, dateColumn: 'transaction_date', dateColumnType: 'DATE' },
  right: { ref: right, dateColumn: 'deposit_date', dateColumnType: 'DATE' },
  key: [{ name: 'transaction_id', leftType: 'STRING', rightType: 'STRING' }],
  values: [{ name: 'amount', leftType: 'NUMERIC', rightType: 'FLOAT64' }],
  startDate: '2026-08-01',
  endDate: '2026-08-31',
};

describe('assertReadOnly', () => {
  it('accepts every query the app generates', () => {
    const filter = { column: 'transaction_date', type: 'DATE', start: '2026-08-01', end: '2026-08-31' };
    const generated = [
      listDatasetsSql('kz-dp-prod').sql,
      listTablesSql('kz-dp-prod', 'dpp_gold_prod').sql,
      columnsSql(ref).sql,
      partitionsSql(ref).sql,
      sampleSql(ref, ['transaction_id', 'amount'], filter).sql,
      columnStatsSql(ref, columns, filter, true).sql,
      topValuesSql(ref, columns, filter).sql,
      jobLineageSql(ref).sql,
      joinHistorySql(ref).sql,
      countsSql(spec).sql,
      countriesSql().sql,
    ];
    for (const sql of generated) {
      expect(() => assertReadOnly(sql)).not.toThrow();
    }
  });

  it('rejects DML, DDL and scripting', () => {
    const hostile = [
      'DELETE FROM `p.d.t` WHERE 1=1',
      'DROP TABLE `p.d.t`',
      'CREATE OR REPLACE TABLE `p.d.t` AS SELECT 1',
      'UPDATE `p.d.t` SET a = 1',
      'MERGE `p.d.t` USING `p.d.s` ON TRUE WHEN MATCHED THEN DELETE',
      'GRANT `roles/bigquery.admin` ON TABLE `p.d.t` TO "user:x@y.z"',
      'BEGIN SELECT 1; END',
      'CALL `p.d.proc`()',
      'EXPORT DATA OPTIONS(uri="gs://x") AS SELECT 1',
    ];
    for (const sql of hostile) {
      expect(() => assertReadOnly(sql), sql).toThrow(UnsafeQueryError);
    }
  });

  it('rejects a second statement smuggled after a SELECT', () => {
    expect(() => assertReadOnly('SELECT 1; DROP TABLE `p.d.t`')).toThrow(UnsafeQueryError);
  });

  it('tolerates a single trailing semicolon', () => {
    expect(() => assertReadOnly('SELECT 1;')).not.toThrow();
  });

  it('is not fooled by keywords inside string literals or comments', () => {
    expect(() => assertReadOnly("SELECT 'DROP TABLE x' AS note")).not.toThrow();
    expect(() => assertReadOnly('SELECT 1 -- DROP TABLE x')).not.toThrow();
    expect(() => assertReadOnly('SELECT 1 /* DELETE FROM y */')).not.toThrow();
  });

  it('does not fire on columns whose names contain SQL keywords', () => {
    expect(() => assertReadOnly('SELECT `update`, `load`, `set` FROM `p.d.t`')).not.toThrow();
  });
});

describe('stripLiteralsAndComments', () => {
  it('removes comments, literals and back-quoted identifiers', () => {
    const stripped = stripLiteralsAndComments("SELECT `a` /* c */ , 'lit' -- trailing\nFROM `p.d.t`");
    expect(stripped).not.toContain('lit');
    expect(stripped).not.toContain('trailing');
    expect(stripped).not.toContain('p.d.t');
  });
});

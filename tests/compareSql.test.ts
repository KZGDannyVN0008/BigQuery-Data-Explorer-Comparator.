import { describe, expect, it } from 'vitest';
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
} from '@/lib/sql/compare';
import { assertReadOnly } from '@/lib/bigquery';
import { areComparableTypes, castToString, isKeyable, normalizedCompareExpr, toDateExpr } from '@/lib/sql/types';

const base: CompareSpec = {
  left: {
    ref: { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'ph_dpp_deposit_v2_gold' },
    dateColumn: 'transaction_date',
    dateColumnType: 'DATE',
  },
  right: {
    ref: { project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' },
    dateColumn: 'deposit_date',
    dateColumnType: 'DATE',
  },
  key: [{ name: 'transaction_id', leftType: 'STRING', rightType: 'STRING' }],
  values: [
    { name: 'amount', leftType: 'NUMERIC', rightType: 'FLOAT64' },
    { name: 'status', leftType: 'STRING', rightType: 'STRING' },
  ],
  startDate: '2026-08-01',
  endDate: '2026-08-31',
};

describe('validateSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(() => validateSpec(base)).not.toThrow();
  });

  it('requires at least one key column', () => {
    expect(() => validateSpec({ ...base, key: [] })).toThrow(CompareSpecError);
  });

  it('rejects a FLOAT64 key because float equality is not reliable', () => {
    expect(() =>
      validateSpec({ ...base, key: [{ name: 'amount', leftType: 'FLOAT64', rightType: 'FLOAT64' }] }),
    ).toThrow(/cannot be used as a comparison key/);
  });

  it('rejects a key whose types are incompatible across sides', () => {
    expect(() =>
      validateSpec({ ...base, key: [{ name: 'transaction_id', leftType: 'STRING', rightType: 'INT64' }] }),
    ).toThrow(/incompatible types/);
  });

  it('rejects an inverted date range', () => {
    expect(() => validateSpec({ ...base, startDate: '2026-08-31', endDate: '2026-08-01' })).toThrow(
      /must not be after/,
    );
  });

  it('rejects a window wider than the configured maximum', () => {
    expect(() => validateSpec({ ...base, startDate: '2020-01-01', endDate: '2026-08-31' })).toThrow(
      /exceeds the .* maximum/,
    );
  });

  it('rejects more value columns than the cap allows', () => {
    const values = Array.from({ length: 31 }, (_, i) => ({
      name: `col_${i}`,
      leftType: 'STRING',
      rightType: 'STRING',
    }));
    expect(() => validateSpec({ ...base, values })).toThrow(/Too many value columns/);
  });
});

describe('generated comparison SQL', () => {
  const page = { page: 0, pageSize: 50 };
  const all = [
    countsSql(base),
    dateCoverageSql(base),
    missingDatesSql(base),
    onlyInSideSql(base, 'left', page),
    onlyInSideSql(base, 'right', page),
    duplicateKeysSql(base, page),
    valueMismatchesSql(base, page),
  ];

  it('is read-only in every case', () => {
    for (const query of all) expect(() => assertReadOnly(query.sql)).not.toThrow();
  });

  it('binds the date range as parameters rather than interpolating it', () => {
    for (const query of all) {
      expect(query.params).toEqual({ start: '2026-08-01', end: '2026-08-31' });
      expect(query.sql).toContain('@start');
      expect(query.sql).toContain('@end');
      expect(query.sql).not.toContain('2026-08-01');
    }
  });

  it('filters both sides on their own date column', () => {
    const sql = countsSql(base).sql;
    expect(sql).toContain('`transaction_date` BETWEEN @start AND @end');
    expect(sql).toContain('`deposit_date` BETWEEN @start AND @end');
  });

  it('builds a null-safe composite key', () => {
    const composite = countsSql({
      ...base,
      key: [
        { name: 'transaction_id', leftType: 'STRING', rightType: 'STRING' },
        { name: 'merchant', leftType: 'STRING', rightType: 'STRING' },
      ],
    }).sql;
    expect(composite).toContain('TO_JSON_STRING([`transaction_id`, `merchant`])');
  });

  it('counts duplicates, gaps and drift in one query', () => {
    const sql = countsSql(base).sql;
    for (const alias of [
      'left_row_count',
      'right_row_count',
      'matched_keys',
      'only_in_left',
      'only_in_right',
      'duplicate_keys_left',
      'duplicate_keys_right',
      'value_mismatches',
    ]) {
      expect(sql).toContain(alias);
    }
  });

  it('compares values null-safely', () => {
    expect(countsSql(base).sql).toContain('IS DISTINCT FROM');
  });

  it('paginates previews with LIMIT and OFFSET', () => {
    const second = onlyInSideSql(base, 'left', { page: 2, pageSize: 25 });
    expect(second.sql).toContain('LIMIT 25 OFFSET 50');
  });

  it('clamps an oversized page size to the configured maximum', () => {
    const huge = onlyInSideSql(base, 'left', { page: 0, pageSize: 100_000 });
    expect(huge.sql).toMatch(/LIMIT 200 OFFSET 0/);
  });

  it('refuses a value diff when no value columns are comparable', () => {
    expect(() => valueMismatchesSql({ ...base, values: [] }, page)).toThrow(CompareSpecError);
  });

  it('unpivots mismatches to one row per differing column', () => {
    const sql = valueMismatchesSql(base, page).sql;
    expect(sql).toContain('CROSS JOIN UNNEST(diffs)');
    expect(sql).toContain('`left_value`');
    expect(sql).toContain('`right_value`');
  });
});

describe('type helpers', () => {
  it('treats numeric families as comparable and mixed families as not', () => {
    expect(areComparableTypes('NUMERIC', 'FLOAT64')).toBe(true);
    expect(areComparableTypes('DATE', 'TIMESTAMP')).toBe(true);
    expect(areComparableTypes('STRING', 'INT64')).toBe(false);
    expect(areComparableTypes('NUMERIC(38, 9)', 'NUMERIC')).toBe(true);
  });

  it('excludes floats from key eligibility', () => {
    expect(isKeyable('STRING')).toBe(true);
    expect(isKeyable('INT64')).toBe(true);
    expect(isKeyable('FLOAT64')).toBe(false);
    expect(isKeyable('STRUCT<a INT64>')).toBe(false);
  });

  it('base64-encodes BYTES rather than casting them to STRING', () => {
    expect(castToString('`b`', 'BYTES')).toBe('TO_BASE64(`b`)');
  });

  it('normalises numerics and strings before comparison', () => {
    expect(normalizedCompareExpr('`amount`', 'FLOAT64')).toBe('CAST(`amount` AS BIGNUMERIC)');
    expect(normalizedCompareExpr('`status`', 'STRING')).toBe('TRIM(`status`)');
  });

  it('derives a UTC calendar date from each temporal type', () => {
    expect(toDateExpr('`d`', 'DATE')).toBe('`d`');
    expect(toDateExpr('`t`', 'TIMESTAMP')).toBe("DATE(`t`, 'UTC')");
    expect(() => toDateExpr('`s`', 'STRING')).toThrow(/cannot be used as a date filter/);
  });
});

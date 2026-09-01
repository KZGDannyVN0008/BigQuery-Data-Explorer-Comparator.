import { describe, expect, it } from 'vitest';
import {
  InvalidIdentifierError,
  assertColumn,
  assertCountry,
  assertDate,
  assertDataset,
  assertProject,
  assertTable,
  assertTableRef,
  parseRef,
  quoteColumn,
  quoteTable,
} from '@/lib/identifiers';

describe('project validation', () => {
  it('accepts the allowlisted projects', () => {
    expect(assertProject('kz-dp-prod')).toBe('kz-dp-prod');
    expect(assertProject('kz-kura')).toBe('kz-kura');
  });

  it('rejects a well-formed project that is not allowlisted', () => {
    expect(() => assertProject('some-other-proj')).toThrow(/not in the allowlist/);
  });

  it('rejects injection attempts in the project id', () => {
    for (const value of ['kz-dp-prod`;DROP', 'kz dp prod', '`kz-kura`', 'kz-dp-prod.x', '']) {
      expect(() => assertProject(value)).toThrow(InvalidIdentifierError);
    }
  });
});

describe('dataset, table and column validation', () => {
  it('accepts conventional names', () => {
    expect(assertDataset('dpp_gold_prod')).toBe('dpp_gold_prod');
    expect(assertTable('ph_dpp_deposit_v2_gold')).toBe('ph_dpp_deposit_v2_gold');
    expect(assertColumn('merchant')).toBe('merchant');
    expect(assertColumn('_private')).toBe('_private');
  });

  it('rejects back-ticks, dots, spaces and quotes', () => {
    const hostile = ['a`b', 'a.b', 'a b', "a'b", 'a"b', 'a;b', 'a)b'];
    for (const value of hostile) {
      expect(() => assertDataset(value)).toThrow(InvalidIdentifierError);
      expect(() => assertColumn(value)).toThrow(InvalidIdentifierError);
    }
  });

  it('rejects a column starting with a digit', () => {
    expect(() => assertColumn('1st_column')).toThrow(InvalidIdentifierError);
  });
});

describe('date validation', () => {
  it('accepts real calendar dates', () => {
    expect(assertDate('2026-09-01')).toBe('2026-09-01');
    expect(assertDate('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects malformed and impossible dates', () => {
    for (const value of ['2026-9-1', '2026/09/01', '2026-02-30', '2023-02-29', 'yesterday', '']) {
      expect(() => assertDate(value)).toThrow(InvalidIdentifierError);
    }
  });
});

describe('quoting', () => {
  it('produces a fully qualified back-quoted table', () => {
    expect(quoteTable({ project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' })).toBe(
      '`kz-kura.kura_gold.ph_deposit_v2`',
    );
  });

  it('quotes columns with and without an alias', () => {
    expect(quoteColumn('merchant')).toBe('`merchant`');
    expect(quoteColumn('merchant', 'l')).toBe('l.`merchant`');
  });

  it('refuses to quote anything that failed validation', () => {
    expect(() => quoteTable({ project: 'kz-kura', dataset: 'x`y', table: 't' })).toThrow(InvalidIdentifierError);
    expect(() => quoteColumn('x`y')).toThrow(InvalidIdentifierError);
  });
});

describe('parseRef and assertTableRef', () => {
  it('parses a dotted reference', () => {
    expect(parseRef('kz-dp-prod.crm_gold_prod.merchant_dim')).toEqual({
      project: 'kz-dp-prod',
      dataset: 'crm_gold_prod',
      table: 'merchant_dim',
    });
  });

  it('rejects a reference with the wrong number of parts', () => {
    expect(() => parseRef('kz-dp-prod.merchant_dim')).toThrow(InvalidIdentifierError);
  });

  it('validates every part of a ref object', () => {
    expect(() => assertTableRef({ project: 'kz-kura', dataset: 'ok', table: 'bad table' })).toThrow(
      InvalidIdentifierError,
    );
  });
});

describe('country codes', () => {
  it('upper-cases two-letter codes', () => {
    expect(assertCountry('ph')).toBe('PH');
  });

  it('rejects anything else', () => {
    for (const value of ['PHL', 'p', '1H', '']) {
      expect(() => assertCountry(value)).toThrow(InvalidIdentifierError);
    }
  });
});

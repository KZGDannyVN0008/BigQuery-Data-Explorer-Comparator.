import { describe, expect, it } from 'vitest';
import { extractAliases, extractUsingConditions, parseJoins } from '@/lib/joinParser';

const GOLD = 'kz-dp-prod.dpp_gold_prod.ph_dpp_deposit_v2_gold';
const KURA = 'kz-kura.kura_gold.ph_deposit_v2';

describe('extractAliases', () => {
  it('binds aliases to fully qualified tables', () => {
    const aliases = extractAliases(`SELECT 1 FROM \`${GOLD}\` AS g JOIN \`${KURA}\` k ON g.id = k.id`);
    expect(aliases.find((a) => a.alias === 'g')?.ref.table).toBe('ph_dpp_deposit_v2_gold');
    expect(aliases.find((a) => a.alias === 'k')?.ref.table).toBe('ph_deposit_v2');
  });

  it('ignores CTE names that cannot be resolved to a real table', () => {
    const aliases = extractAliases('WITH x AS (SELECT 1) SELECT * FROM x JOIN y ON x.a = y.a');
    expect(aliases).toHaveLength(0);
  });
});

describe('parseJoins', () => {
  it('extracts a single ON equality with both sides resolved', () => {
    const sql = `SELECT * FROM \`${GOLD}\` AS g JOIN \`${KURA}\` AS k ON g.transaction_id = k.transaction_id`;
    const [condition, ...rest] = parseJoins(sql);
    expect(rest).toHaveLength(0);
    expect(condition.left.table.table).toBe('ph_dpp_deposit_v2_gold');
    expect(condition.left.column).toBe('transaction_id');
    expect(condition.right.table.project).toBe('kz-kura');
    expect(condition.right.column).toBe('transaction_id');
  });

  it('extracts every AND-ed equality in a composite join', () => {
    const sql = `
      SELECT * FROM \`${GOLD}\` AS g
      FULL OUTER JOIN \`${KURA}\` AS k
        ON g.transaction_id = k.transaction_id AND g.merchant = k.merchant
      WHERE g.transaction_date = CURRENT_DATE()`;
    const conditions = parseJoins(sql);
    expect(conditions.map((c) => `${c.left.column}=${c.right.column}`).sort()).toEqual([
      'merchant=merchant',
      'transaction_id=transaction_id',
    ]);
  });

  it('stops at the WHERE clause and does not treat filters as join keys', () => {
    const sql = `SELECT * FROM \`${GOLD}\` g JOIN \`${KURA}\` k ON g.id = k.id WHERE g.country = k.country`;
    const conditions = parseJoins(sql);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].left.column).toBe('id');
  });

  it('discards predicates whose alias cannot be resolved to a table', () => {
    const sql = `WITH t AS (SELECT 1 AS id) SELECT * FROM t JOIN \`${KURA}\` k ON t.id = k.id`;
    expect(parseJoins(sql)).toHaveLength(0);
  });

  it('ignores self-joins on the same table', () => {
    const sql = `SELECT * FROM \`${GOLD}\` a JOIN \`${GOLD}\` b ON a.id = b.parent_id`;
    expect(parseJoins(sql)).toHaveLength(0);
  });

  it('finds nothing in a query with no JOIN at all', () => {
    expect(parseJoins(`SELECT * FROM \`${GOLD}\` WHERE amount > 0`)).toHaveLength(0);
  });

  it('is not confused by a join condition inside a string literal', () => {
    const sql = `SELECT 'ON a.x = b.y' AS note FROM \`${GOLD}\``;
    expect(parseJoins(sql)).toHaveLength(0);
  });
});

describe('extractUsingConditions', () => {
  it('expands USING into one equality per column', () => {
    const sql = `SELECT * FROM \`${GOLD}\` JOIN \`${KURA}\` USING (merchant, country)`;
    const conditions = extractUsingConditions(sql);
    expect(conditions.map((c) => c.left.column)).toEqual(['merchant', 'country']);
    expect(conditions.every((c) => c.right.table.project === 'kz-kura')).toBe(true);
  });
});

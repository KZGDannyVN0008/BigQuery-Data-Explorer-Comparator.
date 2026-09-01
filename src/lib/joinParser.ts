/**
 * Extracts JOIN predicates from historical SQL.
 *
 * This is deliberately conservative. A relationship is only reported when a real
 * query actually joined the two tables on specific columns; two tables sharing a
 * column called `merchant` is not, on its own, evidence of anything.
 *
 * The parser resolves aliases back to fully-qualified tables, so
 * `JOIN kz-kura.x.b AS b ON a.merchant = b.merchant` yields the pair
 * (a.merchant, b.merchant) with both tables identified.
 */

import type { TableRef } from './types';

export interface ParsedJoinCondition {
  left: { table: TableRef; column: string };
  right: { table: TableRef; column: string };
}

interface AliasBinding {
  alias: string;
  ref: TableRef;
}

const IDENT = '[A-Za-z0-9_-]+';
/** `project.dataset.table`, optionally back-quoted in whole or in part. */
const QUALIFIED = new RegExp(
  '`?(' + IDENT + ')`?\\.`?(' + IDENT + ')`?\\.`?(' + IDENT + ')`?',
);

function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'''[\s\S]*?'''/g, "''")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\s+/g, ' ');
}

/**
 * Collects `FROM`/`JOIN` table references and their aliases.
 * Unqualified names (CTEs, temp aliases) are skipped — they cannot be resolved
 * to a real table, so any predicate touching them is discarded rather than guessed.
 */
export function extractAliases(sql: string): AliasBinding[] {
  const cleaned = stripNoise(sql);
  const bindings: AliasBinding[] = [];
  const pattern = new RegExp(
    '\\b(?:FROM|JOIN)\\s+' +
      '(`?' + IDENT + '`?(?:\\.`?' + IDENT + '`?){0,2})' +
      '(?:\\s+(?:AS\\s+)?(?!ON\\b|USING\\b|LEFT\\b|RIGHT\\b|INNER\\b|FULL\\b|OUTER\\b|CROSS\\b|JOIN\\b|WHERE\\b|GROUP\\b|ORDER\\b|LIMIT\\b|UNION\\b|ON\\b)(' +
      '[A-Za-z_][A-Za-z0-9_]*))?',
    'gi',
  );

  for (const match of cleaned.matchAll(pattern)) {
    const rawTable = match[1];
    const alias = match[2];
    const qualified = QUALIFIED.exec(rawTable.replace(/`/g, '') + '');
    if (!qualified) continue;
    const ref: TableRef = { project: qualified[1], dataset: qualified[2], table: qualified[3] };
    bindings.push({ alias: (alias ?? ref.table).toLowerCase(), ref });
    // The bare table name is also a valid reference when no alias is declared.
    if (alias && alias.toLowerCase() !== ref.table.toLowerCase()) {
      bindings.push({ alias: ref.table.toLowerCase(), ref });
    }
  }
  return bindings;
}

/** `ON a.col = b.col` and each `AND`-ed equality that follows it. */
export function extractJoinConditions(sql: string): ParsedJoinCondition[] {
  const cleaned = stripNoise(sql);
  const aliases = extractAliases(cleaned);
  if (aliases.length < 2) return [];

  const byAlias = new Map<string, TableRef>();
  for (const b of aliases) {
    if (!byAlias.has(b.alias)) byAlias.set(b.alias, b.ref);
  }

  const results: ParsedJoinCondition[] = [];
  // Everything from an ON up to the next clause keyword is the join predicate.
  const onPattern = /\bON\b([\s\S]*?)(?=\b(?:LEFT|RIGHT|INNER|FULL|CROSS|JOIN|WHERE|GROUP|ORDER|HAVING|LIMIT|WINDOW|QUALIFY|UNION)\b|$)/gi;
  const equality = new RegExp(
    '\\b(' + '[A-Za-z_][A-Za-z0-9_]*' + ')\\.`?([A-Za-z_][A-Za-z0-9_]*)`?' +
      '\\s*=\\s*' +
      '\\b([A-Za-z_][A-Za-z0-9_]*)\\.`?([A-Za-z_][A-Za-z0-9_]*)`?',
    'g',
  );

  for (const onMatch of cleaned.matchAll(onPattern)) {
    const predicate = onMatch[1] ?? '';
    for (const eq of predicate.matchAll(equality)) {
      const [, leftAlias, leftCol, rightAlias, rightCol] = eq;
      const leftRef = byAlias.get(leftAlias.toLowerCase());
      const rightRef = byAlias.get(rightAlias.toLowerCase());
      if (!leftRef || !rightRef) continue; // unresolved alias: no guessing
      if (
        leftRef.project === rightRef.project &&
        leftRef.dataset === rightRef.dataset &&
        leftRef.table === rightRef.table
      ) {
        continue; // self-join on the same table tells us nothing about relationships
      }
      results.push({
        left: { table: leftRef, column: leftCol },
        right: { table: rightRef, column: rightCol },
      });
    }
  }
  return results;
}

/** `USING (merchant, country)` expands to one equality per column. */
export function extractUsingConditions(sql: string): ParsedJoinCondition[] {
  const cleaned = stripNoise(sql);
  const results: ParsedJoinCondition[] = [];
  const pattern = new RegExp(
    '\\bJOIN\\s+(`?' + IDENT + '`?(?:\\.`?' + IDENT + '`?){2})' +
      '(?:\\s+(?:AS\\s+)?[A-Za-z_][A-Za-z0-9_]*)?' +
      '\\s+USING\\s*\\(([^)]*)\\)',
    'gi',
  );

  // The left-hand side of a USING join is whichever table was named first.
  const aliases = extractAliases(cleaned);
  if (aliases.length === 0) return results;
  const first = aliases[0].ref;

  for (const match of cleaned.matchAll(pattern)) {
    const qualified = QUALIFIED.exec(match[1].replace(/`/g, ''));
    if (!qualified) continue;
    const right: TableRef = { project: qualified[1], dataset: qualified[2], table: qualified[3] };
    if (right.project === first.project && right.dataset === first.dataset && right.table === first.table) {
      continue;
    }
    for (const rawCol of match[2].split(',')) {
      const column = rawCol.trim().replace(/`/g, '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) continue;
      results.push({
        left: { table: first, column },
        right: { table: right, column },
      });
    }
  }
  return results;
}

export function parseJoins(sql: string): ParsedJoinCondition[] {
  return [...extractJoinConditions(sql), ...extractUsingConditions(sql)];
}

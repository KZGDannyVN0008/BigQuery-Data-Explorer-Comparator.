/**
 * Country shortcut: the distinct country list, and the default table for each.
 */

import 'server-only';
import { config, countryTableRef } from '../config';
import { runQuery, toPlainRows } from '../bigquery';
import { assertCountry, quoteColumn, quoteTable } from '../identifiers';
import type { GeneratedSql, TableRef } from '../types';

export function countriesSql(): GeneratedSql {
  const { countrySourceTable, countryColumn } = config.countryShortcut;
  const column = quoteColumn(countryColumn);
  return {
    label: 'countries',
    sql: `
SELECT DISTINCT UPPER(${column}) AS country
FROM ${quoteTable(countrySourceTable)}
WHERE ${column} IS NOT NULL
ORDER BY country
`.trim(),
    params: {},
  };
}

export interface CountryEntry {
  country: string;
  ref: TableRef;
}

/** Countries plus the default deposit table each one maps to. */
export async function listCountries(): Promise<{ countries: CountryEntry[]; sql: GeneratedSql }> {
  const query = countriesSql();
  const { rows } = await runQuery<{ country: string }>({
    ...query,
    mock: { ref: config.countryShortcut.countrySourceTable },
  });

  const countries = toPlainRows<{ country: string }>(rows)
    .map((r) => String(r.country ?? '').toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c))
    .map((country) => ({ country, ref: countryTableRef(country) }));

  return { countries, sql: query };
}

/** `kz-dp-prod.dpp_gold_prod.${country.toLowerCase()}_dpp_deposit_v2_gold` */
export function defaultTableForCountry(country: string): TableRef {
  return countryTableRef(assertCountry(country));
}

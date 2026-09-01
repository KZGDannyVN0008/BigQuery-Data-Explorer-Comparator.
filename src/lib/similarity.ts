/**
 * Candidate-table suggestion for cross-project comparison.
 *
 * Scoring blends four independent signals so no single one can carry a match on
 * its own — in particular, a shared column name contributes to `columnOverlap`
 * but is never treated as a relationship (see relationships.ts for that).
 */

import { baseType } from './sql/types';
import type { TableSuggestion, TableRef } from './types';

/** Country codes seen in the warehouse; extended at runtime from the shortcut query. */
export const KNOWN_COUNTRIES = ['PH', 'BD', 'MX', 'PK', 'TH', 'BR', 'EG', 'CO', 'PE'];

/** Environment/versioning noise that should not influence name similarity. */
const NOISE_TOKENS = new Set([
  'prod', 'production', 'dev', 'stg', 'staging', 'test', 'tmp', 'temp',
  'gold', 'silver', 'bronze', 'raw', 'curated',
  'v1', 'v2', 'v3', 'v4', 'final', 'new', 'old', 'copy', 'bak', 'backup',
  'daily', 'hourly', 'snapshot', 'tbl', 'table',
]);

/** Splits on non-alphanumerics only, so version tokens like `v2` stay whole. */
export function tokenize(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Leading two-letter country code, e.g. `ph_dpp_deposit_v2_gold` -> `PH`. */
export function countryPrefix(name: string, known: string[] = KNOWN_COUNTRIES): string | null {
  const first = tokenize(name)[0];
  if (!first || first.length !== 2) return null;
  const upper = first.toUpperCase();
  return known.includes(upper) ? upper : null;
}

/** Name with the country prefix and noise tokens removed. */
export function coreTokens(name: string, known: string[] = KNOWN_COUNTRIES): string[] {
  const tokens = tokenize(name);
  const withoutCountry =
    tokens.length > 0 && tokens[0].length === 2 && known.includes(tokens[0].toUpperCase())
      ? tokens.slice(1)
      : tokens;
  const filtered = withoutCountry.filter((t) => !NOISE_TOKENS.has(t));
  return filtered.length > 0 ? filtered : withoutCountry;
}

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function trigrams(value: string): string[] {
  const padded = `  ${value.toLowerCase()} `;
  const out: string[] = [];
  for (let i = 0; i < padded.length - 2; i += 1) out.push(padded.slice(i, i + 3));
  return out;
}

/** Blend of token overlap and character trigram overlap; 0..1. */
export function nameSimilarity(a: string, b: string, known: string[] = KNOWN_COUNTRIES): number {
  const tokensA = coreTokens(a, known);
  const tokensB = coreTokens(b, known);
  const tokenScore = jaccard(tokensA, tokensB);
  const trigramScore = jaccard(trigrams(tokensA.join('_')), trigrams(tokensB.join('_')));
  return 0.6 * tokenScore + 0.4 * trigramScore;
}

export interface CandidateColumns {
  ref: TableRef;
  columns: Array<{ name: string; type: string }>;
}

export interface ScoreWeights {
  name: number;
  country: number;
  columns: number;
  types: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  name: 0.35,
  country: 0.15,
  columns: 0.35,
  types: 0.15,
};

/** Scores one candidate against the source table. */
export function scoreCandidate(
  source: CandidateColumns,
  candidate: CandidateColumns,
  known: string[] = KNOWN_COUNTRIES,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): TableSuggestion {
  const sourceCols = new Map(source.columns.map((c) => [c.name.toLowerCase(), baseType(c.type)]));
  const candidateCols = new Map(candidate.columns.map((c) => [c.name.toLowerCase(), baseType(c.type)]));

  const shared: string[] = [];
  let typeMatches = 0;
  for (const [name, type] of sourceCols) {
    const other = candidateCols.get(name);
    if (other === undefined) continue;
    shared.push(name);
    if (other === type) typeMatches += 1;
  }

  const columnOverlap = jaccard(sourceCols.keys(), candidateCols.keys());
  const typeMatchRatio = shared.length === 0 ? 0 : typeMatches / shared.length;
  const nameScore = nameSimilarity(source.ref.table, candidate.ref.table, known);

  const sourceCountry = countryPrefix(source.ref.table, known);
  const candidateCountry = countryPrefix(candidate.ref.table, known);
  const countryScore =
    sourceCountry && candidateCountry ? (sourceCountry === candidateCountry ? 1 : 0) : 0;

  const score =
    weights.name * nameScore +
    weights.country * countryScore +
    weights.columns * columnOverlap +
    weights.types * typeMatchRatio;

  const reasons: string[] = [];
  if (nameScore >= 0.5) reasons.push(`Table names are ${Math.round(nameScore * 100)}% similar`);
  if (countryScore === 1) reasons.push(`Same country prefix (${sourceCountry})`);
  else if (sourceCountry && candidateCountry) reasons.push(`Different country prefix (${sourceCountry} vs ${candidateCountry})`);
  if (shared.length > 0) {
    reasons.push(`${shared.length} shared columns (${Math.round(columnOverlap * 100)}% overlap)`);
    reasons.push(`${Math.round(typeMatchRatio * 100)}% of shared columns have identical types`);
  }

  return {
    ref: candidate.ref,
    score: Number(score.toFixed(4)),
    reasons,
    nameSimilarity: Number(nameScore.toFixed(4)),
    countryPrefix: candidateCountry,
    columnOverlap: Number(columnOverlap.toFixed(4)),
    typeMatchRatio: Number(typeMatchRatio.toFixed(4)),
    sharedColumns: shared.sort(),
  };
}

/** Ranked suggestions, weakest matches dropped. */
export function rankCandidates(
  source: CandidateColumns,
  candidates: CandidateColumns[],
  options: { limit?: number; minScore?: number; known?: string[] } = {},
): TableSuggestion[] {
  const { limit = 10, minScore = 0.2, known = KNOWN_COUNTRIES } = options;
  return candidates
    .filter((c) => !(c.ref.project === source.ref.project && c.ref.dataset === source.ref.dataset && c.ref.table === source.ref.table))
    .map((c) => scoreCandidate(source, c, known))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.ref.table.localeCompare(b.ref.table))
    .slice(0, limit);
}

/**
 * Columns that make a sensible comparison key: shared, keyable, high-cardinality
 * by name convention, and type-compatible. Ranked, not chosen — the user confirms.
 */
export function suggestKeyColumns(
  shared: Array<{ name: string; leftType: string; rightType: string }>,
): Array<{ name: string; leftType: string; rightType: string; score: number }> {
  const strong = /^(id|.*_id|uuid|guid|.*_key|.*_no|.*_number|reference|ref|txn.*|transaction.*|order.*)$/;
  const medium = /(merchant|customer|user|account|wallet|player)/;
  return shared
    .map((c) => {
      const name = c.name.toLowerCase();
      let score = 0.1;
      if (strong.test(name)) score = 0.9;
      else if (medium.test(name)) score = 0.5;
      if (name === 'id') score = 1;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

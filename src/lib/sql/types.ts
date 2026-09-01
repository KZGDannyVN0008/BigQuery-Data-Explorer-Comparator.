/** BigQuery type helpers shared by the profiler and the comparator. */

/** Strips parameterisation and ARRAY/STRUCT wrappers: NUMERIC(38,9) -> NUMERIC. */
export function baseType(dataType: string): string {
  const trimmed = dataType.trim().toUpperCase();
  const paren = trimmed.indexOf('(');
  const head = paren === -1 ? trimmed : trimmed.slice(0, paren);
  if (head.startsWith('ARRAY<')) return 'ARRAY';
  if (head.startsWith('STRUCT<')) return 'STRUCT';
  return head;
}

const ORDERABLE = new Set([
  'INT64', 'INTEGER', 'FLOAT64', 'FLOAT', 'NUMERIC', 'DECIMAL', 'BIGNUMERIC', 'BIGDECIMAL',
  'STRING', 'BYTES', 'DATE', 'DATETIME', 'TIME', 'TIMESTAMP', 'BOOL', 'BOOLEAN',
]);

const NUMERIC_TYPES = new Set([
  'INT64', 'INTEGER', 'FLOAT64', 'FLOAT', 'NUMERIC', 'DECIMAL', 'BIGNUMERIC', 'BIGDECIMAL',
]);

const TEMPORAL_TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);

/** MIN/MAX and GROUP BY are only valid for scalar, orderable types. */
export function isOrderable(dataType: string): boolean {
  return ORDERABLE.has(baseType(dataType));
}

export function isNumeric(dataType: string): boolean {
  return NUMERIC_TYPES.has(baseType(dataType));
}

/** Types that can back a date filter. */
export function isTemporal(dataType: string): boolean {
  return TEMPORAL_TYPES.has(baseType(dataType));
}

/** Types usable as a comparison key: scalar, groupable, and stable across systems. */
export function isKeyable(dataType: string): boolean {
  const t = baseType(dataType);
  return isOrderable(t) && t !== 'FLOAT64' && t !== 'FLOAT';
}

/**
 * Two types are comparable when a value round-trips between them without
 * changing meaning. INT64 vs NUMERIC is comparable; STRING vs INT64 is not.
 */
export function areComparableTypes(left: string, right: string): boolean {
  const a = baseType(left);
  const b = baseType(right);
  if (a === b) return true;
  if (isNumeric(a) && isNumeric(b)) return true;
  const dateish = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);
  if (dateish.has(a) && dateish.has(b)) return true;
  return false;
}

/**
 * Renders `expr` as a STRING for display or key building.
 * BYTES is base64-encoded because CAST(BYTES AS STRING) fails on non-UTF8 input.
 */
export function castToString(expr: string, dataType: string): string {
  const t = baseType(dataType);
  if (t === 'BYTES') return `TO_BASE64(${expr})`;
  if (t === 'STRING') return expr;
  if (t === 'JSON') return `TO_JSON_STRING(${expr})`;
  if (t === 'ARRAY' || t === 'STRUCT') return `TO_JSON_STRING(${expr})`;
  if (t === 'TIMESTAMP') return `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', ${expr}, 'UTC')`;
  return `CAST(${expr} AS STRING)`;
}

/**
 * Normalises a value so semantically-equal values compare equal across systems:
 * numbers lose trailing-zero noise, strings lose surrounding whitespace.
 */
export function normalizedCompareExpr(expr: string, dataType: string): string {
  const t = baseType(dataType);
  if (isNumeric(t)) return `CAST(${expr} AS BIGNUMERIC)`;
  if (t === 'STRING') return `TRIM(${expr})`;
  if (t === 'TIMESTAMP' || t === 'DATETIME') return `CAST(${expr} AS TIMESTAMP)`;
  return expr;
}

/** Expression producing the calendar date of a temporal column, in UTC. */
export function toDateExpr(expr: string, dataType: string): string {
  const t = baseType(dataType);
  if (t === 'DATE') return expr;
  if (t === 'TIMESTAMP') return `DATE(${expr}, 'UTC')`;
  if (t === 'DATETIME') return `DATE(${expr})`;
  throw new Error(`Column of type ${dataType} cannot be used as a date filter`);
}

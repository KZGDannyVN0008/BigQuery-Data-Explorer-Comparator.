/** Central runtime configuration. All values are server-side only. */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export const DEFAULT_PROJECTS = ['kz-dp-prod', 'kz-kura'] as const;

export const config = {
  /** Projects the UI is allowed to browse. Anything else is rejected server-side. */
  allowedProjects: list('ALLOWED_PROJECTS', [...DEFAULT_PROJECTS]),

  /** Region whose INFORMATION_SCHEMA / JOBS views are queried. */
  location: process.env.BIGQUERY_LOCATION ?? 'US',

  /** Hard ceiling handed to BigQuery via maximumBytesBilled. */
  maxBytesBilled: num('MAX_BYTES_BILLED', 20 * 1024 ** 3), // 20 GiB

  /** Dry-run estimates above this are refused before the real query runs. */
  dryRunLimitBytes: num('DRY_RUN_LIMIT_BYTES', 20 * 1024 ** 3), // 20 GiB

  /** On-demand price per TiB scanned, used only for the displayed estimate. */
  usdPerTib: num('BQ_USD_PER_TIB', 6.25),

  /** Rows returned to the browser for any single preview. */
  previewPageSize: num('PREVIEW_PAGE_SIZE', 50),
  previewMaxPageSize: num('PREVIEW_MAX_PAGE_SIZE', 200),

  /** Upper bound on rows a preview COUNT will report before saying "capped". */
  previewMaxTotal: num('PREVIEW_MAX_TOTAL', 10_000),

  /** Sample rows shown in the Sample Data tab. */
  sampleRowLimit: num('SAMPLE_ROW_LIMIT', 50),

  /** Top-N frequency values computed per column. */
  topValuesLimit: num('TOP_VALUES_LIMIT', 10),

  /** Maximum days a comparison window may span. */
  maxCompareWindowDays: num('MAX_COMPARE_WINDOW_DAYS', 92),

  /** Days of JOB history mined for JOIN predicates. */
  joinHistoryDays: num('JOIN_HISTORY_DAYS', 30),

  /** Query timeout in milliseconds. */
  queryTimeoutMs: num('QUERY_TIMEOUT_MS', 120_000),

  /** Serve deterministic fixtures instead of calling BigQuery. */
  mockMode: process.env.BQ_MOCK === '1' || process.env.BQ_MOCK === 'true',

  countryShortcut: {
    countrySourceTable: {
      project: 'kz-dp-prod',
      dataset: 'crm_gold_prod',
      table: 'deposit_transaction_consolidated',
    },
    countryColumn: 'country',
    /** Pattern applied to the lower-cased country code. */
    targetProject: 'kz-dp-prod',
    targetDataset: 'dpp_gold_prod',
    targetTableSuffix: '_dpp_deposit_v2_gold',
  },
} as const;

/** `kz-dp-prod.dpp_gold_prod.${country.toLowerCase()}_dpp_deposit_v2_gold` */
export function countryTableRef(country: string) {
  const c = config.countryShortcut;
  return {
    project: c.targetProject,
    dataset: c.targetDataset,
    table: `${country.toLowerCase()}${c.targetTableSuffix}`,
  };
}

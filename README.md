# BigQuery Data Explorer & Comparator

A read-only web application for exploring BigQuery tables, understanding how they
relate to each other, and comparing the same data as it lands in two different
projects.

Built with Next.js (App Router) + TypeScript, `@google-cloud/bigquery`, and React
Flow. Authenticates with Application Default Credentials and deploys to Cloud Run.

---

## What it does

### 1. Table Explorer

Cascading **Project → Dataset → Table** selection across the allowlisted projects
(`kz-dp-prod`, `kz-kura` by default). Once a table is selected:

| Shown | Source |
| --- | --- |
| Schema, column types, modes, descriptions | `INFORMATION_SCHEMA.COLUMNS` + `COLUMN_FIELD_PATHS` |
| Row count, logical size, created / last modified | `INFORMATION_SCHEMA.TABLE_STORAGE` |
| Partition column, type, filter requirement, expiration, clustering | `TABLE_OPTIONS` + `PARTITIONS` |
| Sample rows | `SELECT … LIMIT n`, date-filtered, on demand |
| Null counts, distinct counts, min/max | one aggregate query over the selected columns |
| Top values and their frequency | grouped query per column, unioned into one job |

Metadata queries are free (`INFORMATION_SCHEMA` is metadata, not table data).
Sampling and profiling are **opt-in per column**, because BigQuery bills for every
column a query reads.

### 2. Relationship Graph

The selected table is rendered as a React Flow node with its related tables
around it — upstream on the left, downstream on the right.

Relationships come from four independent sources, and every edge records which
one it came from:

| Source | Evidence | Confidence |
| --- | --- | --- |
| Manually confirmed | curated entry in `config/manual-relationships.json` | 1.00 |
| Foreign key | declared `FOREIGN KEY` in `TABLE_CONSTRAINTS` | 0.95 |
| Primary key | declared `PRIMARY KEY` | 0.90 |
| Lineage | jobs in `INFORMATION_SCHEMA.JOBS` that read A and wrote B | 0.70 |
| JOIN history | `ON` predicates parsed out of recent query text | 0.50–0.95, scaled by how often the join was actually run |

Each connection displays its column-level predicate:

```
ph_dpp_deposit_v2_gold.transaction_id = ph_deposit_v2.transaction_id
```

**Two tables are never linked merely because they have columns with the same
name.** A shared column name contributes to comparison *suggestions* (§3), but it
never produces a relationship edge. Every edge traces back to a job that ran, a
constraint that was declared, or a person who confirmed it.

When a source is unavailable — typically no permission on `JOBS_BY_PROJECT` — the
graph still renders from the remaining sources and says what was missing.

### 3. Table Comparison

Compare any two tables across projects, in three confirmed steps.

**Suggest.** Selecting a `kz-dp-prod` table and asking for candidates in `kz-kura`
ranks every table in the target project by a blend of four signals:

- table-name similarity (country prefixes and environment noise like `v2`, `gold`, `prod` are stripped before comparing)
- country prefix match (`ph_…` vs `ph_…`)
- shared-column overlap
- data-type agreement across those shared columns

**Confirm.** The user picks the target table, the comparison key (a single column
or a composite), the date column on each side, and the window. Nothing runs until
they do. Only columns present on both sides with compatible types can be keys, and
`FLOAT64` is rejected as a key because float equality is not reliable.

**Compare.** The result reports:

- columns missing from either side, and data-type differences (flagged as comparable or not)
- records present on one side only
- duplicate keys on each side
- value mismatches, unpivoted to one row per differing column
- row-count delta, and date coverage on each side including dates present on only one

Both sides are reduced to a null-safe key (`TO_JSON_STRING([...])`),
deduplicated, then `FULL OUTER JOIN`ed. Values are compared with
`IS DISTINCT FROM` after normalisation, so `NULL` vs `NULL` matches and
`NUMERIC 1.50` vs `FLOAT64 1.5` does not produce a false difference.

A date filter is **mandatory** on both sides, the window is capped
(`MAX_COMPARE_WINDOW_DAYS`, default 92), and every result set is paginated.

### 4. Country Shortcut

Countries are loaded with:

```sql
SELECT DISTINCT UPPER(country) AS country
FROM `kz-dp-prod.crm_gold_prod.deposit_transaction_consolidated`
WHERE country IS NOT NULL
ORDER BY country
```

Each becomes a one-click jump to the default deposit table:

```js
`kz-dp-prod.dpp_gold_prod.${country.toLowerCase()}_dpp_deposit_v2_gold`
```

Current countries: PH, BD, MX, PK, TH, BR, EG, CO, PE. The list is read from the
warehouse rather than hard-coded, so new countries appear automatically.

---

## Security model

The application is read-only by construction, not by convention.

**All BigQuery access happens on the server.** Every `@google-cloud/bigquery`
call sits behind `src/lib/bigquery.ts`, which imports `server-only` — a build
error, not a runtime one, if it is ever pulled into a client component. The
browser talks exclusively to this app's own API routes.

**Credentials never reach the browser.** Authentication is Application Default
Credentials: `gcloud auth application-default login` locally, the attached service
account on Cloud Run. There is no key file in the repository, and no configuration
value is prefixed `NEXT_PUBLIC_`.

**No arbitrary SQL.** There is no endpoint that accepts a query. The SQL tab is a
log of what the server generated, not an editor. Every statement is built from
templates in `src/lib/sql/`.

**Identifiers are validated, values are parameterised.** BigQuery cannot
parameterise table and column names, so identifiers go through three gates:

1. a strict character allowlist (`src/lib/identifiers.ts`) — back-ticks, dots, quotes, spaces and semicolons are rejected;
2. the project allowlist (`ALLOWED_PROJECTS`);
3. an existence check against `INFORMATION_SCHEMA` before the name is ever interpolated.

Everything else — dates, filters, search values — is bound as a named query
parameter and never concatenated into SQL.

**Defense in depth on the generated SQL.** `assertReadOnly()` runs on every
query before it is submitted: it strips comments, string literals and back-quoted
identifiers, then requires the statement to begin with `SELECT` or `WITH`,
rejects DDL/DML/scripting keywords, and rejects multiple statements. This guards
against a bug in our own SQL builders, not just against user input.

**Cost is capped twice.** Every query is dry-run first and refused if the estimate
exceeds `DRY_RUN_LIMIT_BYTES`; the executed query then carries
`maximumBytesBilled`, so BigQuery itself kills anything that overruns. A
comparison dry-runs its entire plan before executing any part of it.

**Large tables never reach the browser.** Sampling is capped, profiling is
per-column and opt-in, comparison previews are `LIMIT`/`OFFSET` paginated, and
preview totals are capped at `PREVIEW_MAX_TOTAL`.

**Errors do not leak infrastructure detail.** Validation errors are returned
verbatim so the user can fix their input; anything else is logged server-side and
returned as a generic message.

### Required IAM

Grant the service account read-only roles. Nothing here permits a write.

```bash
PROJECT_ID=kz-dp-prod
SA=bq-explorer-run@${PROJECT_ID}.iam.gserviceaccount.com

# Read table data and metadata — in every project the app may browse.
for P in kz-dp-prod kz-kura; do
  gcloud projects add-iam-policy-binding "$P" \
    --member="serviceAccount:${SA}" --role="roles/bigquery.dataViewer"
done

# Run query jobs, billed to the host project. This role cannot modify data.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" --role="roles/bigquery.jobUser"

# Optional: lineage and JOIN-history discovery reads INFORMATION_SCHEMA.JOBS.
# Without it the Relationships tab still works from constraints and the curated
# file, and tells the user which sources were unavailable.
for P in kz-dp-prod kz-kura; do
  gcloud projects add-iam-policy-binding "$P" \
    --member="serviceAccount:${SA}" --role="roles/bigquery.resourceViewer"
done
```

Do **not** grant `bigquery.dataEditor`, `bigquery.admin`, or `bigquery.user`
(which allows dataset creation). `dataViewer` + `jobUser` is the whole surface.

---

## Getting started

### Prerequisites

- Node.js 20 or newer
- `gcloud` CLI, for local credentials

### Install and run with mock data

No credentials needed. The fixture warehouse mirrors the real one closely enough
to exercise every feature, with differences deliberately planted between the two
sides so the comparator has something real to find.

```bash
npm install
BQ_MOCK=1 npm run dev
# http://localhost:3000
```

### Run against real BigQuery

```bash
gcloud auth application-default login
cp .env.example .env.local        # then edit GOOGLE_CLOUD_PROJECT etc.
npm run dev
```

### Tests and checks

```bash
npm test         # 109 unit and integration tests, no credentials required
npm run typecheck
npm run build
```

The suite covers identifier validation and injection attempts, the read-only
guard, the JOIN parser, similarity scoring, comparison SQL generation, relationship
merging, formatting, and an end-to-end pass over every service against the mock
warehouse.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones worth
knowing:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOWED_PROJECTS` | `kz-dp-prod,kz-kura` | Projects the UI may browse; everything else is rejected |
| `BIGQUERY_LOCATION` | `US` | Region for `INFORMATION_SCHEMA` and `JOBS` — must match your datasets |
| `MAX_BYTES_BILLED` | 20 GiB | Hard ceiling enforced by BigQuery |
| `DRY_RUN_LIMIT_BYTES` | 20 GiB | Estimate above which a query is refused before it runs |
| `MAX_COMPARE_WINDOW_DAYS` | 92 | Widest permitted comparison window |
| `PREVIEW_PAGE_SIZE` | 50 | Rows per preview page |
| `JOIN_HISTORY_DAYS` | 30 | Days of job history mined for lineage and JOIN predicates |
| `BQ_MOCK` | unset | Serve fixtures instead of calling BigQuery |

### Curated relationships

Relationships a human has confirmed live in
[`config/manual-relationships.json`](config/manual-relationships.json). The app
only reads this file — keeping it read-only is what lets the whole service run
without write access to anything.

```json
{
  "relationships": [
    {
      "from": "kz-dp-prod.dpp_gold_prod.ph_dpp_deposit_v2_gold",
      "to": "kz-kura.kura_gold.ph_deposit_v2",
      "direction": "upstream",
      "columns": [{ "from": "transaction_id", "to": "transaction_id" }],
      "note": "Confirmed by the DPP team on 2026-06-18."
    }
  ]
}
```

`direction` is relative to the first table: `upstream` means `to` feeds `from`.
Point `MANUAL_RELATIONSHIPS_PATH` at a mounted secret or config map to manage the
file outside the image.

---

## Deploying to Cloud Run

### One-off deploy

```bash
PROJECT_ID=kz-dp-prod
REGION=asia-southeast1
SERVICE=bq-data-explorer
SA=bq-explorer-run@${PROJECT_ID}.iam.gserviceaccount.com

# 1. Service account with read-only BigQuery access (see "Required IAM" above).
gcloud iam service-accounts create bq-explorer-run \
  --display-name="BigQuery Data Explorer (Cloud Run)" --project="$PROJECT_ID"

# 2. Artifact Registry repository.
gcloud artifacts repositories create apps \
  --repository-format=docker --location="$REGION" --project="$PROJECT_ID"

# 3. Build and deploy.
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION="$REGION",_SERVICE="$SERVICE",_RUNTIME_SA="$SA" \
  --project="$PROJECT_ID"
```

Or build and deploy directly:

```bash
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --no-allow-unauthenticated \
  --memory 1Gi --cpu 1 --concurrency 40 --timeout 300 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},ALLOWED_PROJECTS=kz-dp-prod\,kz-kura,BIGQUERY_LOCATION=US,MAX_BYTES_BILLED=21474836480"
```

### Access control

The service deploys with `--no-allow-unauthenticated`. It has no
authentication of its own, and it shows warehouse data — so put an
authenticating layer in front before anyone uses it:

```bash
# Grant specific people permission to invoke the service…
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" --member="user:analyst@example.com" --role="roles/run.invoker"

# …or front it with Identity-Aware Proxy on an external HTTPS load balancer
# and restrict access to a Google group.
```

Do not add `--allow-unauthenticated`.

### Notes

- The image builds with `output: 'standalone'`, runs as a non-root user, and needs no writable filesystem.
- Cloud Run sets `PORT`; the container honours it (default 8080).
- Set `--min-instances=1` if the ~2 s cold start on the first query is disruptive.
- Query cost is billed to `GOOGLE_CLOUD_PROJECT`. Set a [custom quota](https://cloud.google.com/bigquery/docs/custom-quotas) on that project as a backstop beyond the app's own limits.

---

## Project layout

```
src/
  app/
    api/                      Route handlers — the only path from browser to BigQuery
    page.tsx, layout.tsx      Server shell
    globals.css               Design tokens and base styles
  components/
    Explorer.tsx              Selection state and tab orchestration
    TableSelector.tsx         Project → Dataset → Table cascade + date window
    CountryShortcut.tsx       Country → default deposit table
    tabs/                     Overview | Columns | Sample Data | Relationships | Compare | SQL
    ui.tsx                    Panels, stats, badges, data grid, pagination
  lib/
    bigquery.ts               Client, read-only guard, dry-run costing, byte caps
    identifiers.ts            Identifier allowlists and quoting
    config.ts                 Environment-driven limits
    sql/                      Query builders: introspection, profile, compare, lineage, types
    services/                 catalog · profile · relationships · compare · countries
    joinParser.ts             JOIN predicate extraction from historical SQL
    similarity.ts             Table-suggestion scoring and key ranking
    relationships.ts          Evidence merging and graph construction
    mock/                     Fixture warehouse: catalogue, rows, query router, comparison
tests/                        Unit and integration suites (vitest)
config/                       Curated relationships
```

---

## Known limitations

- **Lineage depth is one hop.** The graph shows a table's direct neighbours, not the full transitive closure.
- **JOIN history is regex-based, not a SQL parser.** It resolves aliases to fully-qualified tables and discards anything it cannot resolve, so it under-reports rather than guessing. Predicates inside CTEs referencing other CTEs are skipped.
- **Distinct counts are approximate above 5M rows.** `APPROX_COUNT_DISTINCT` is used there and the UI says so.
- **Comparison caps at 30 value columns** per run, to bound query size and cost.
- **`INFORMATION_SCHEMA.JOBS` is region-scoped and project-scoped.** Lineage only sees jobs run in `BIGQUERY_LOCATION` within the allowlisted projects. Jobs run from other projects against these tables are invisible.
- **No caching.** Every page interaction re-queries metadata. Metadata queries are free; adding a short-lived cache would mainly reduce latency.

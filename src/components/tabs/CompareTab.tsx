'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '@/lib/client';
import { daysBetween, formatNumber, formatPercent, formatUsd } from '@/lib/format';
import type {
  CompareResult,
  GeneratedSql,
  TableMetadata,
  TableRef,
  TableSuggestion,
} from '@/lib/types';
import type { DateWindow, Limits } from '../Explorer';
import { Badge, DataTable, Empty, Notice, Pagination, Panel, Spinner, Stat } from '../ui';

interface SuggestionResponse {
  source: TableRef;
  targetProject: string;
  suggestions: TableSuggestion[];
  keyCandidates: Array<{ name: string; leftType: string; rightType: string; score: number }>;
}

const PREVIEWS = [
  { key: 'onlyInLeft', label: 'Missing from right' },
  { key: 'onlyInRight', label: 'Missing from left' },
  { key: 'duplicateKeys', label: 'Duplicate keys' },
  { key: 'valueMismatches', label: 'Value mismatches' },
] as const;

type PreviewKey = (typeof PREVIEWS)[number]['key'];

export function CompareTab({
  metadata,
  projects,
  window,
  limits,
  onSql,
}: {
  metadata: TableMetadata;
  projects: string[];
  window: DateWindow;
  limits: Limits;
  onSql: (entries: GeneratedSql[]) => void;
}) {
  const otherProject = projects.find((p) => p !== metadata.ref.project) ?? metadata.ref.project;

  const [targetProject, setTargetProject] = useState(otherProject);
  const [suggestions, setSuggestions] = useState<SuggestionResponse | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const [target, setTarget] = useState<TableMetadata | null>(null);
  const [keyColumns, setKeyColumns] = useState<string[]>([]);
  const [leftDateColumn, setLeftDateColumn] = useState(metadata.partition.field ?? '');
  const [rightDateColumn, setRightDateColumn] = useState('');
  const [range, setRange] = useState<DateWindow>(window);

  const [result, setResult] = useState<CompareResult | null>(null);
  const [preview, setPreview] = useState<PreviewKey>('onlyInLeft');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selecting a different source table invalidates the whole comparison setup.
  useEffect(() => {
    setSuggestions(null);
    setTarget(null);
    setKeyColumns([]);
    setResult(null);
    setLeftDateColumn(metadata.partition.field ?? '');
    setRightDateColumn('');
  }, [metadata.ref.project, metadata.ref.dataset, metadata.ref.table, metadata.partition.field]);

  useEffect(() => setRange(window), [window]);

  const temporalColumns = useCallback(
    (meta: TableMetadata | null) =>
      (meta?.columns ?? []).filter((c) => ['DATE', 'DATETIME', 'TIMESTAMP'].includes(c.type.toUpperCase())),
    [],
  );

  const sharedColumns = useMemo(() => {
    if (!target) return [];
    const rightByName = new Map(target.columns.map((c) => [c.name.toLowerCase(), c]));
    return metadata.columns
      .filter((c) => rightByName.has(c.name.toLowerCase()))
      .map((c) => ({
        name: c.name,
        leftType: c.type,
        rightType: rightByName.get(c.name.toLowerCase())!.type,
      }));
  }, [metadata, target]);

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const data = await apiPost<SuggestionResponse>('/api/compare/suggest', {
        ref: metadata.ref,
        targetProject,
      });
      setSuggestions(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  const confirmTarget = async (ref: TableRef) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiGet<{ metadata: TableMetadata }>('/api/table', {
        project: ref.project,
        dataset: ref.dataset,
        table: ref.table,
      });
      setTarget(data.metadata);
      setRightDateColumn(data.metadata.partition.field ?? '');

      // Pre-select the highest-ranked key, but the user still confirms it.
      const ranked = suggestions?.keyCandidates ?? [];
      const rightNames = new Set(data.metadata.columns.map((c) => c.name.toLowerCase()));
      const best = ranked.find((c) => rightNames.has(c.name.toLowerCase()));
      setKeyColumns(best ? [best.name] : []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async (nextPage = 0) => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const data = await apiPost<CompareResult>('/api/compare/run', {
        left: metadata.ref,
        right: target.ref,
        keyColumns,
        leftDateColumn,
        rightDateColumn,
        startDate: range.startDate,
        endDate: range.endDate,
        page: nextPage,
        pageSize: limits.previewPageSize,
      });
      setResult(data);
      setPage(nextPage);
      onSql(data.sql);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const windowDays = daysBetween(range.startDate, range.endDate);
  const windowTooWide = windowDays > limits.maxCompareWindowDays;
  const canRun =
    Boolean(target) && keyColumns.length > 0 && Boolean(leftDateColumn) && Boolean(rightDateColumn) && !windowTooWide && windowDays > 0;

  return (
    <div className="stack">
      <Panel
        title="1 · Choose a comparison target"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
            <label className="field" style={{ minWidth: 160 }}>
              <span>Target project</span>
              <select value={targetProject} onChange={(event) => setTargetProject(event.target.value)}>
                {projects.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="primary" onClick={suggest} disabled={suggesting}>
              {suggesting ? 'Searching…' : 'Suggest similar tables'}
            </button>
          </div>
        }
      >
        <div className="muted" style={{ marginBottom: '0.75rem' }}>
          Comparing <code>{metadata.ref.project}.{metadata.ref.dataset}.{metadata.ref.table}</code> against a table in{' '}
          <code>{targetProject}</code>. Candidates are ranked by table-name similarity, country prefix, and matching
          columns and data types.
        </div>

        {suggestions && suggestions.suggestions.length === 0 ? (
          <Empty>No sufficiently similar tables found in {suggestions.targetProject}.</Empty>
        ) : null}

        {suggestions && suggestions.suggestions.length > 0 ? (
          <div className="table-scroll" style={{ maxHeight: 300 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th className="num">Score</th>
                  <th className="num">Name</th>
                  <th>Country</th>
                  <th className="num">Column overlap</th>
                  <th className="num">Type match</th>
                  <th>Why</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {suggestions.suggestions.map((suggestion) => {
                  const selected =
                    target?.ref.dataset === suggestion.ref.dataset && target?.ref.table === suggestion.ref.table;
                  return (
                    <tr key={`${suggestion.ref.dataset}.${suggestion.ref.table}`} style={selected ? { background: 'var(--accent-soft)' } : undefined}>
                      <td className="mono">
                        {suggestion.ref.dataset}.{suggestion.ref.table}
                      </td>
                      <td className="num">
                        <Badge tone={suggestion.score > 0.7 ? 'good' : suggestion.score > 0.45 ? 'accent' : undefined}>
                          {Math.round(suggestion.score * 100)}
                        </Badge>
                      </td>
                      <td className="num">{formatPercent(suggestion.nameSimilarity * 100, 0)}</td>
                      <td>{suggestion.countryPrefix ?? <span className="faint">—</span>}</td>
                      <td className="num">{formatPercent(suggestion.columnOverlap * 100, 0)}</td>
                      <td className="num">{formatPercent(suggestion.typeMatchRatio * 100, 0)}</td>
                      <td className="muted" style={{ whiteSpace: 'normal', minWidth: 260 }}>
                        {suggestion.reasons.join('; ')}
                      </td>
                      <td>
                        <button type="button" onClick={() => confirmTarget(suggestion.ref)} disabled={busy}>
                          {selected ? 'Selected' : 'Confirm'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      {target ? (
        <Panel
          title="2 · Confirm the key and window"
          actions={
            <button type="button" className="primary" onClick={() => run(0)} disabled={!canRun || busy}>
              {busy ? 'Comparing…' : 'Run comparison'}
            </button>
          }
        >
          <div className="row">
            <label className="field grow">
              <span>Left date column ({metadata.ref.table})</span>
              <select value={leftDateColumn} onChange={(event) => setLeftDateColumn(event.target.value)}>
                <option value="">Select a date column</option>
                {temporalColumns(metadata).map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.type}){c.isPartitioningColumn ? ' — partition' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="field grow">
              <span>Right date column ({target.ref.table})</span>
              <select value={rightDateColumn} onChange={(event) => setRightDateColumn(event.target.value)}>
                <option value="">Select a date column</option>
                {temporalColumns(target).map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.type}){c.isPartitioningColumn ? ' — partition' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="field" style={{ maxWidth: 165 }}>
              <span>From</span>
              <input
                type="date"
                value={range.startDate}
                max={range.endDate}
                onChange={(event) => setRange({ ...range, startDate: event.target.value })}
              />
            </label>
            <label className="field" style={{ maxWidth: 165 }}>
              <span>To</span>
              <input
                type="date"
                value={range.endDate}
                min={range.startDate}
                onChange={(event) => setRange({ ...range, endDate: event.target.value })}
              />
            </label>
          </div>

          <div style={{ marginTop: '0.9rem' }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: '0.35rem' }}>
              Comparison key — pick one column or several to form a composite key. Only columns present on both
              sides with compatible types are listed.
            </div>
            <div className="scroll-list">
              {sharedColumns.length === 0 ? (
                <Empty>The two tables share no columns.</Empty>
              ) : (
                sharedColumns.map((column) => (
                  <label key={column.name} className="check-row">
                    <input
                      type="checkbox"
                      checked={keyColumns.includes(column.name)}
                      onChange={() =>
                        setKeyColumns((current) =>
                          current.includes(column.name)
                            ? current.filter((c) => c !== column.name)
                            : [...current, column.name],
                        )
                      }
                    />
                    <code>{column.name}</code>
                    <span className="faint">
                      {column.leftType}
                      {column.leftType !== column.rightType ? ` → ${column.rightType}` : ''}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            {windowTooWide ? (
              <Notice tone="error">
                The window is {windowDays} days; the maximum is {limits.maxCompareWindowDays}. Narrow the range.
              </Notice>
            ) : (
              <Notice>
                A date filter is mandatory on both sides. This run covers {windowDays} day
                {windowDays === 1 ? '' : 's'} and returns at most {limits.previewPageSize} preview rows per page.
              </Notice>
            )}
          </div>
        </Panel>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}
      {busy && !result ? <Spinner label="Running comparison queries…" /> : null}

      {result ? <CompareResults result={result} preview={preview} onPreview={setPreview} page={page} onPage={run} busy={busy} /> : null}
    </div>
  );
}

function CompareResults({
  result,
  preview,
  onPreview,
  page,
  onPage,
  busy,
}: {
  result: CompareResult;
  preview: PreviewKey;
  onPreview: (key: PreviewKey) => void;
  page: number;
  onPage: (page: number) => void;
  busy: boolean;
}) {
  const { counts, schemaDiff, dateCoverage } = result;
  const active = result.previews[preview];
  const columns = active.rows.length > 0 ? Object.keys(active.rows[0]) : [];

  return (
    <div className="stack">
      <Panel title="Results">
        <div className="stat-grid">
          <Stat label="Left rows" value={formatNumber(counts.leftRows)} sub={result.request.left.table} />
          <Stat label="Right rows" value={formatNumber(counts.rightRows)} sub={result.request.right.table} />
          <Stat
            label="Row-count delta"
            value={formatNumber(counts.rowCountDelta)}
            tone={counts.rowCountDelta === 0 ? 'good' : 'warn'}
          />
          <Stat label="Matched keys" value={formatNumber(counts.matchedKeys)} tone="good" />
          <Stat
            label="Missing from right"
            value={formatNumber(counts.onlyInLeft)}
            tone={counts.onlyInLeft === 0 ? 'good' : 'bad'}
          />
          <Stat
            label="Missing from left"
            value={formatNumber(counts.onlyInRight)}
            tone={counts.onlyInRight === 0 ? 'good' : 'bad'}
          />
          <Stat
            label="Duplicate keys"
            value={`${formatNumber(counts.duplicateKeysLeft)} / ${formatNumber(counts.duplicateKeysRight)}`}
            sub="left / right"
            tone={counts.duplicateKeysLeft + counts.duplicateKeysRight === 0 ? 'good' : 'warn'}
          />
          <Stat
            label="Keys with value drift"
            value={formatNumber(counts.valueMismatches)}
            tone={counts.valueMismatches === 0 ? 'good' : 'warn'}
          />
        </div>

        <div className="row" style={{ marginTop: '1rem', gap: '2rem' }}>
          <dl className="kv">
            <dt>Key</dt>
            <dd className="mono">{result.request.keyColumns.join(' + ')}</dd>
            <dt>Window</dt>
            <dd>
              {result.request.startDate} → {result.request.endDate}
            </dd>
            <dt>Estimated scan</dt>
            <dd>
              {formatNumber(Math.round(result.costEstimate.bytesProcessed / 1024 ** 2))} MiB ·{' '}
              {formatUsd(result.costEstimate.estimatedUsd)}
            </dd>
          </dl>
          <dl className="kv">
            <dt>Left coverage</dt>
            <dd>
              {dateCoverage.left.min ?? '—'} → {dateCoverage.left.max ?? '—'} ({dateCoverage.left.days} days)
            </dd>
            <dt>Right coverage</dt>
            <dd>
              {dateCoverage.right.min ?? '—'} → {dateCoverage.right.max ?? '—'} ({dateCoverage.right.days} days)
            </dd>
            <dt>Dates missing right</dt>
            <dd>
              {dateCoverage.missingDatesInRight.length === 0 ? (
                <span className="faint">none</span>
              ) : (
                <span className="mono">{dateCoverage.missingDatesInRight.slice(0, 8).join(', ')}
                  {dateCoverage.missingDatesInRight.length > 8 ? ` +${dateCoverage.missingDatesInRight.length - 8}` : ''}
                </span>
              )}
            </dd>
            <dt>Dates missing left</dt>
            <dd>
              {dateCoverage.missingDatesInLeft.length === 0 ? (
                <span className="faint">none</span>
              ) : (
                <span className="mono">{dateCoverage.missingDatesInLeft.slice(0, 8).join(', ')}
                  {dateCoverage.missingDatesInLeft.length > 8 ? ` +${dateCoverage.missingDatesInLeft.length - 8}` : ''}
                </span>
              )}
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel title="Schema differences" flush>
        <div style={{ padding: '1rem', display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <ColumnList
            title={`Missing from ${result.request.right.table}`}
            columns={schemaDiff.missingInRight.map((c) => `${c.name} (${c.type})`)}
          />
          <ColumnList
            title={`Missing from ${result.request.left.table}`}
            columns={schemaDiff.missingInLeft.map((c) => `${c.name} (${c.type})`)}
          />
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: '0.35rem' }}>
              Data-type differences
            </div>
            {schemaDiff.typeMismatches.length === 0 ? (
              <span className="faint">None</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: 12.5 }}>
                {schemaDiff.typeMismatches.map((mismatch) => (
                  <li key={mismatch.column} className="mono">
                    {mismatch.column}: {mismatch.leftType} vs {mismatch.rightType}{' '}
                    {mismatch.comparable ? <Badge tone="warn">comparable</Badge> : <Badge tone="bad">not compared</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title="Preview"
        actions={
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            {PREVIEWS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="chip"
                aria-pressed={preview === entry.key}
                onClick={() => onPreview(entry.key)}
              >
                {entry.label} ({formatNumber(result.previews[entry.key].total)})
              </button>
            ))}
          </div>
        }
        flush
      >
        <DataTable columns={columns} rows={active.rows} />
        <div style={{ padding: '0.75rem 1rem' }}>
          <Pagination
            page={page}
            pageSize={active.pageSize}
            total={active.total}
            capped={active.capped}
            onChange={onPage}
            busy={busy}
          />
        </div>
      </Panel>
    </div>
  );
}

function ColumnList({ title, columns }: { title: string; columns: string[] }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: '0.35rem' }}>
        {title}
      </div>
      {columns.length === 0 ? (
        <span className="faint">None</span>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: 12.5 }} className="mono">
          {columns.map((column) => (
            <li key={column}>{column}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

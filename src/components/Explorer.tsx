'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet } from '@/lib/client';
import { isoDaysAgo } from '@/lib/format';
import type { TableMetadata, TableRef } from '@/lib/types';
import { Badge, Notice, Spinner } from './ui';
import { TableSelector, type DatasetSummary, type TableSummary } from './TableSelector';
import { CountryShortcut, type CountryEntry } from './CountryShortcut';
import { OverviewTab } from './tabs/OverviewTab';
import { ColumnsTab } from './tabs/ColumnsTab';
import { SampleDataTab } from './tabs/SampleDataTab';
import { RelationshipsTab } from './tabs/RelationshipsTab';
import { CompareTab } from './tabs/CompareTab';
import { SqlTab } from './tabs/SqlTab';

const TABS = ['Overview', 'Columns', 'Sample Data', 'Relationships', 'Compare', 'SQL'] as const;
export type TabName = (typeof TABS)[number];

export interface DateWindow {
  startDate: string;
  endDate: string;
}

export interface Limits {
  maxCompareWindowDays: number;
  previewPageSize: number;
  sampleRowLimit: number;
}

export function Explorer({
  projects,
  mockMode,
  limits,
}: {
  projects: string[];
  mockMode: boolean;
  limits: Limits;
}) {
  const [project, setProject] = useState(projects[0] ?? '');
  const [dataset, setDataset] = useState('');
  const [table, setTable] = useState('');

  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [countries, setCountries] = useState<CountryEntry[]>([]);

  const [metadata, setMetadata] = useState<TableMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabName>('Overview');

  // A 7-day trailing window keeps the first profiling query cheap on partitioned
  // tables; the user widens it deliberately.
  const [window, setWindow] = useState<DateWindow>({
    startDate: isoDaysAgo(7),
    endDate: isoDaysAgo(0),
  });

  /** Generated SQL collected from every tab, shown in the SQL tab. */
  const [sqlLog, setSqlLog] = useState<Array<{ label: string; sql: string; params: Record<string, unknown> }>>([]);
  const recordSql = useCallback(
    (entries: Array<{ label: string; sql: string; params: Record<string, unknown> }>) => {
      setSqlLog((current) => {
        const next = [...entries, ...current];
        const seen = new Set<string>();
        return next.filter((entry) => {
          const key = `${entry.label}:${entry.sql}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 40);
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setDatasets([]);
    setDataset('');
    setTables([]);
    setTable('');
    setMetadata(null);
    if (!project) return;

    apiGet<{ datasets: DatasetSummary[] }>('/api/datasets', { project })
      .then((data) => {
        if (!cancelled) setDatasets(data.datasets);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    let cancelled = false;
    setTables([]);
    setTable('');
    setMetadata(null);
    if (!project || !dataset) return;

    apiGet<{ tables: TableSummary[] }>('/api/tables', { project, dataset })
      .then((data) => {
        if (!cancelled) setTables(data.tables);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, dataset]);

  useEffect(() => {
    let cancelled = false;
    if (!project || !dataset || !table) {
      setMetadata(null);
      return;
    }
    setLoading(true);
    setError(null);

    apiGet<{ metadata: TableMetadata }>('/api/table', { project, dataset, table })
      .then((data) => {
        if (cancelled) return;
        setMetadata(data.metadata);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, dataset, table]);

  useEffect(() => {
    apiGet<{ countries: CountryEntry[] }>('/api/countries')
      .then((data) => setCountries(data.countries))
      .catch(() => setCountries([])); // the shortcut is optional; failure is not fatal
  }, []);

  const selectRef = useCallback((ref: TableRef) => {
    setProject(ref.project);
    setDataset(ref.dataset);
    setTable(ref.table);
    setTab('Overview');
  }, []);

  const ref = useMemo<TableRef | null>(
    () => (project && dataset && table ? { project, dataset, table } : null),
    [project, dataset, table],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>BigQuery Data Explorer &amp; Comparator</h1>
          <span>read-only</span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {mockMode ? <Badge tone="warn">Mock data</Badge> : <Badge tone="good">Live BigQuery</Badge>}
          {metadata ? (
            <span className="mono faint" style={{ fontSize: 11.5 }}>
              {metadata.ref.project}.{metadata.ref.dataset}.{metadata.ref.table}
            </span>
          ) : null}
        </div>
      </header>

      <main className="app-main stack">
        <TableSelector
          projects={projects}
          datasets={datasets}
          tables={tables}
          project={project}
          dataset={dataset}
          table={table}
          window={window}
          onProject={setProject}
          onDataset={setDataset}
          onTable={setTable}
          onWindow={setWindow}
        />

        <CountryShortcut countries={countries} onSelect={selectRef} activeRef={ref} />

        {error ? <Notice tone="error">{error}</Notice> : null}

        {!ref ? (
          <Notice>
            Choose a project, dataset and table to begin. Every query runs on the server with read-only
            credentials, is dry-run costed first, and is capped by a maximum-bytes-billed limit.
          </Notice>
        ) : null}

        {loading ? <Spinner label="Loading table metadata…" /> : null}

        {ref ? (
          <>
            <div className="tabs" role="tablist">
              {TABS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  onClick={() => setTab(name)}
                >
                  {name}
                </button>
              ))}
            </div>

            {metadata ? (
              <>
                {tab === 'Overview' ? <OverviewTab metadata={metadata} /> : null}
                {tab === 'Columns' ? (
                  <ColumnsTab metadata={metadata} window={window} onSql={recordSql} />
                ) : null}
                {tab === 'Sample Data' ? (
                  <SampleDataTab metadata={metadata} window={window} limits={limits} onSql={recordSql} />
                ) : null}
                {tab === 'Relationships' ? (
                  <RelationshipsTab metadata={metadata} onSelect={selectRef} onSql={recordSql} />
                ) : null}
                {tab === 'Compare' ? (
                  <CompareTab
                    metadata={metadata}
                    projects={projects}
                    window={window}
                    limits={limits}
                    onSql={recordSql}
                  />
                ) : null}
                {tab === 'SQL' ? <SqlTab entries={sqlLog} onClear={() => setSqlLog([])} /> : null}
              </>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

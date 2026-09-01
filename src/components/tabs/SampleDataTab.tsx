'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiPost } from '@/lib/client';
import { formatNumber } from '@/lib/format';
import type { GeneratedSql, SampleData, TableMetadata } from '@/lib/types';
import type { DateWindow, Limits } from '../Explorer';
import { DataTable, Notice, Panel, Spinner } from '../ui';

export function SampleDataTab({
  metadata,
  window,
  limits,
  onSql,
}: {
  metadata: TableMetadata;
  window: DateWindow;
  limits: Limits;
  onSql: (entries: GeneratedSql[]) => void;
}) {
  const [sample, setSample] = useState<SampleData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ sample: SampleData; sql: GeneratedSql }>('/api/table/sample', {
        ref: metadata.ref,
        dateColumn: metadata.partition.field ?? undefined,
        startDate: window.startDate,
        endDate: window.endDate,
      });
      setSample(result.sample);
      onSql([result.sql]);
    } catch (err) {
      setError((err as Error).message);
      setSample(null);
    } finally {
      setBusy(false);
    }
  }, [metadata, window.startDate, window.endDate, onSql]);

  useEffect(() => {
    setSample(null);
    setError(null);
  }, [metadata.ref.project, metadata.ref.dataset, metadata.ref.table]);

  return (
    <Panel
      title="Sample data"
      actions={
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className="faint" style={{ fontSize: 12 }}>
            Capped at {formatNumber(limits.sampleRowLimit)} rows
            {metadata.partition.field ? ` · filtered on ${metadata.partition.field}` : ''}
          </span>
          <button type="button" className="primary" onClick={load} disabled={busy}>
            {busy ? 'Loading…' : sample ? 'Refresh sample' : 'Load sample'}
          </button>
        </div>
      }
      flush
    >
      <div style={{ padding: '1rem' }}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {!sample && !error && !busy ? (
          <Notice>
            Sampling is on demand so that opening a table never issues a data query. The date range from the
            selector is applied, and the full table is never loaded into the browser.
          </Notice>
        ) : null}
        {busy ? <Spinner label="Fetching sample rows…" /> : null}
      </div>

      {sample ? (
        <>
          <DataTable columns={sample.columns} rows={sample.rows} />
          <div style={{ padding: '0.6rem 1rem' }} className="faint">
            {formatNumber(sample.rows.length)} rows
            {sample.truncated ? ' (truncated at the row limit)' : ''}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

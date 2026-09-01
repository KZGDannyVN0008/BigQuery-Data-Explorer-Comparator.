'use client';

import { useMemo, useState } from 'react';
import { apiPost } from '@/lib/client';
import { formatNumber, formatPercent } from '@/lib/format';
import type { ColumnProfile, GeneratedSql, TableMetadata } from '@/lib/types';
import type { DateWindow } from '../Explorer';
import { Badge, Empty, Notice, Panel, Spinner } from '../ui';

/** Profiling is opt-in per column because BigQuery bills for every column read. */
const DEFAULT_PROFILE_COLUMNS = 6;

export function ColumnsTab({
  metadata,
  window,
  onSql,
}: {
  metadata: TableMetadata;
  window: DateWindow;
  onSql: (entries: GeneratedSql[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    metadata.columns.slice(0, DEFAULT_PROFILE_COLUMNS).map((c) => c.name),
  );
  const [profiles, setProfiles] = useState<ColumnProfile[] | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [approximate, setApproximate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profileByColumn = useMemo(
    () => new Map((profiles ?? []).map((p) => [p.column, p])),
    [profiles],
  );

  const toggle = (name: string) => {
    setSelected((current) =>
      current.includes(name) ? current.filter((c) => c !== name) : [...current, name],
    );
  };

  const runProfile = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{
        profiles: ColumnProfile[];
        rowCount: number;
        approximate: boolean;
        sql: GeneratedSql[];
      }>('/api/table/profile', {
        ref: metadata.ref,
        columns: selected,
        dateColumn: metadata.partition.field ?? undefined,
        startDate: window.startDate,
        endDate: window.endDate,
      });
      setProfiles(result.profiles);
      setRowCount(result.rowCount);
      setApproximate(result.approximate);
      onSql(result.sql);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Panel
        title="Schema"
        actions={
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <span className="faint" style={{ fontSize: 12 }}>
              {selected.length} of {metadata.columns.length} selected
            </span>
            <button type="button" onClick={() => setSelected(metadata.columns.map((c) => c.name))}>
              Select all
            </button>
            <button type="button" onClick={() => setSelected([])}>
              Clear
            </button>
            <button type="button" className="primary" onClick={runProfile} disabled={busy || selected.length === 0}>
              {busy ? 'Profiling…' : 'Profile selected columns'}
            </button>
          </div>
        }
        flush
      >
        {error ? (
          <div style={{ padding: '1rem' }}>
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}

        {profiles ? (
          <div style={{ padding: '0.75rem 1rem 0' }}>
            <Notice>
              Profiled {formatNumber(rowCount)} rows in the selected window
              {approximate ? '. Distinct counts are approximate (APPROX_COUNT_DISTINCT) on a table this size.' : '.'}
            </Notice>
          </div>
        ) : null}

        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <span className="sr-only">Profile</span>
                </th>
                <th>Column</th>
                <th>Type</th>
                <th>Mode</th>
                <th>Flags</th>
                <th className="num">Nulls</th>
                <th className="num">Null %</th>
                <th className="num">Distinct</th>
                <th>Min</th>
                <th>Max</th>
                <th>Top values</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {metadata.columns.map((column) => {
                const profile = profileByColumn.get(column.name);
                const nullTone = profile && profile.nullPercent > 50 ? 'warn' : undefined;
                return (
                  <tr key={column.name}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(column.name)}
                        onChange={() => toggle(column.name)}
                        aria-label={`Profile ${column.name}`}
                      />
                    </td>
                    <td className="mono">{column.name}</td>
                    <td className="mono">{column.type}</td>
                    <td>{column.mode}</td>
                    <td>
                      <span style={{ display: 'flex', gap: '0.25rem' }}>
                        {column.isPartitioningColumn ? <Badge tone="accent">partition</Badge> : null}
                        {column.clusteringOrdinalPosition !== null ? (
                          <Badge>cluster {column.clusteringOrdinalPosition}</Badge>
                        ) : null}
                      </span>
                    </td>
                    <td className="num">{profile ? formatNumber(profile.nullCount) : '—'}</td>
                    <td className="num">
                      {profile ? (
                        nullTone ? (
                          <Badge tone="warn">{formatPercent(profile.nullPercent)}</Badge>
                        ) : (
                          formatPercent(profile.nullPercent)
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">
                      {profile ? (profile.distinctCount < 0 ? 'n/a' : formatNumber(profile.distinctCount)) : '—'}
                    </td>
                    <td className="mono">{profile?.min ?? '—'}</td>
                    <td className="mono">{profile?.max ?? '—'}</td>
                    <td>
                      {profile && profile.topValues.length > 0 ? (
                        <TopValues profile={profile} />
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="muted" style={{ whiteSpace: 'normal', minWidth: 180 }}>
                      {column.description ?? ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {busy ? (
          <div style={{ padding: '0.75rem 1rem' }}>
            <Spinner label="Running profiling query…" />
          </div>
        ) : null}
        {metadata.columns.length === 0 ? <Empty>This table has no columns.</Empty> : null}
      </Panel>
    </div>
  );
}

function TopValues({ profile }: { profile: ColumnProfile }) {
  const max = Math.max(...profile.topValues.map((v) => v.count), 1);
  return (
    <div style={{ display: 'grid', gap: 2, minWidth: 220 }}>
      {profile.topValues.slice(0, 5).map((entry, index) => (
        <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, alignItems: 'center' }}>
          <span
            className="mono"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              background: `linear-gradient(to right, var(--accent-soft) ${(entry.count / max) * 100}%, transparent ${(entry.count / max) * 100}%)`,
              padding: '1px 3px',
              borderRadius: 3,
            }}
            title={entry.value ?? 'NULL'}
          >
            {entry.value === null ? <span className="null">NULL</span> : entry.value}
          </span>
          <span className="faint" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNumber(entry.count)} ({formatPercent(entry.percent, 1)})
          </span>
        </div>
      ))}
    </div>
  );
}

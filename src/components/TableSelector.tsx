'use client';

import { useMemo, useState } from 'react';
import type { DateWindow } from './Explorer';
import { Panel } from './ui';
import { daysBetween } from '@/lib/format';

export interface DatasetSummary {
  dataset: string;
  location: string | null;
}

export interface TableSummary {
  table: string;
  tableType: string;
  description: string | null;
}

/** Cascading Project → Dataset → Table selection, plus the shared date window. */
export function TableSelector({
  projects,
  datasets,
  tables,
  project,
  dataset,
  table,
  window,
  onProject,
  onDataset,
  onTable,
  onWindow,
}: {
  projects: string[];
  datasets: DatasetSummary[];
  tables: TableSummary[];
  project: string;
  dataset: string;
  table: string;
  window: DateWindow;
  onProject: (value: string) => void;
  onDataset: (value: string) => void;
  onTable: (value: string) => void;
  onWindow: (value: DateWindow) => void;
}) {
  const [filter, setFilter] = useState('');

  const visibleTables = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tables;
    return tables.filter((t) => t.table.toLowerCase().includes(needle));
  }, [tables, filter]);

  const windowDays = daysBetween(window.startDate, window.endDate);

  return (
    <Panel title="Table explorer">
      <div className="row">
        <label className="field grow">
          <span>Project</span>
          <select value={project} onChange={(event) => onProject(event.target.value)}>
            {projects.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="field grow">
          <span>Dataset</span>
          <select
            value={dataset}
            onChange={(event) => onDataset(event.target.value)}
            disabled={datasets.length === 0}
          >
            <option value="">{datasets.length === 0 ? 'Loading…' : 'Select a dataset'}</option>
            {datasets.map((entry) => (
              <option key={entry.dataset} value={entry.dataset}>
                {entry.dataset}
              </option>
            ))}
          </select>
        </label>

        <label className="field grow">
          <span>
            Table{' '}
            {tables.length > 0 ? <span className="faint">({visibleTables.length} of {tables.length})</span> : null}
          </span>
          <select value={table} onChange={(event) => onTable(event.target.value)} disabled={tables.length === 0}>
            <option value="">{dataset ? 'Select a table' : 'Select a dataset first'}</option>
            {visibleTables.map((entry) => (
              <option key={entry.table} value={entry.table}>
                {entry.table}
                {entry.tableType !== 'BASE TABLE' ? ` — ${entry.tableType.toLowerCase()}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field grow">
          <span>Filter tables</span>
          <input
            type="search"
            value={filter}
            placeholder="e.g. deposit"
            onChange={(event) => setFilter(event.target.value)}
            disabled={tables.length === 0}
          />
        </label>
      </div>

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <label className="field" style={{ maxWidth: 170 }}>
          <span>Date range from</span>
          <input
            type="date"
            value={window.startDate}
            max={window.endDate}
            onChange={(event) => onWindow({ ...window, startDate: event.target.value })}
          />
        </label>
        <label className="field" style={{ maxWidth: 170 }}>
          <span>to</span>
          <input
            type="date"
            value={window.endDate}
            min={window.startDate}
            onChange={(event) => onWindow({ ...window, endDate: event.target.value })}
          />
        </label>
        <span className="faint" style={{ fontSize: 12, paddingBottom: '0.55rem' }}>
          {windowDays > 0 ? `${windowDays} day${windowDays === 1 ? '' : 's'}` : 'Invalid range'} — applied to sampling,
          profiling and comparison. Partitioned tables require it.
        </span>
      </div>
    </Panel>
  );
}

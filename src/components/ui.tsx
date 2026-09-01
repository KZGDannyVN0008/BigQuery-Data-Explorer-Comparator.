'use client';

import type { ReactNode } from 'react';
import { cellText, formatNumber } from '@/lib/format';

export function Panel({
  title,
  actions,
  children,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel-header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </header>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'accent' | 'good' | 'warn' | 'bad';
}) {
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warn' | 'error' | 'plain';
}) {
  return <div className={`notice${tone === 'plain' ? '' : ` ${tone}`}`}>{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="muted">
      <span className="spinner" aria-hidden /> {label ?? 'Loading…'}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Generic scrollable result grid. Values are rendered as text, never as HTML. */
export function DataTable({
  columns,
  rows,
  numericColumns = [],
  maxHeight,
}: {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  numericColumns?: string[];
  maxHeight?: number;
}) {
  if (rows.length === 0) return <Empty>No rows to display.</Empty>;
  const numeric = new Set(numericColumns);

  return (
    <div className="table-scroll" style={maxHeight ? { maxHeight } : undefined}>
      <table className="data">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} className={numeric.has(column) ? 'num' : undefined}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const { text, isNull } = cellText(row[column]);
                const isNumeric = numeric.has(column);
                return (
                  <td key={column} className={`mono${isNumeric ? ' num' : ''}`}>
                    {isNull ? <span className="null">NULL</span> : isNumeric ? formatNumber(Number(row[column])) : text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  capped,
  onChange,
  busy,
}: {
  page: number;
  pageSize: number;
  total: number;
  capped: boolean;
  onChange: (page: number) => void;
  busy?: boolean;
}) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const hasNext = to < total;

  return (
    <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
      <span className="faint" style={{ fontSize: 12 }}>
        Showing {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
        {capped ? '+ (count capped for preview)' : ''}
      </span>
      <span style={{ display: 'flex', gap: '0.4rem' }}>
        <button type="button" onClick={() => onChange(page - 1)} disabled={page === 0 || busy}>
          Previous
        </button>
        <button type="button" onClick={() => onChange(page + 1)} disabled={!hasNext || busy}>
          Next
        </button>
      </span>
    </div>
  );
}

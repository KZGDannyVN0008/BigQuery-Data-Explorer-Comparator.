'use client';

import { useState } from 'react';
import type { GeneratedSql } from '@/lib/types';
import { Empty, Notice, Panel } from '../ui';

/**
 * Every query the app has issued this session, with its bound parameters.
 * Read-only by design: there is no editor and no way to submit SQL — the server
 * only ever executes queries it generated itself.
 */
export function SqlTab({ entries, onClear }: { entries: GeneratedSql[]; onClear: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (sql: string, label: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="stack">
      <Notice>
        These are the exact queries this session sent to BigQuery. Identifiers are validated against
        <code> INFORMATION_SCHEMA</code> and every value is bound as a named parameter — the app accepts no SQL from
        the browser.
      </Notice>

      {entries.length === 0 ? (
        <Panel title="Generated SQL">
          <Empty>No queries yet. Load a sample, profile some columns, or run a comparison.</Empty>
        </Panel>
      ) : (
        <Panel
          title={`Generated SQL (${entries.length})`}
          actions={
            <button type="button" onClick={onClear}>
              Clear log
            </button>
          }
        >
          <div className="stack">
            {entries.map((entry, index) => (
              <div key={`${entry.label}-${index}`}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.3rem',
                  }}
                >
                  <code className="muted">{entry.label}</code>
                  <button type="button" className="ghost" onClick={() => copy(entry.sql, `${entry.label}-${index}`)}>
                    {copied === `${entry.label}-${index}` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="sql">{entry.sql}</pre>
                {Object.keys(entry.params ?? {}).length > 0 ? (
                  <div className="faint mono" style={{ fontSize: 11.5, marginTop: '0.3rem' }}>
                    params: {JSON.stringify(entry.params)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

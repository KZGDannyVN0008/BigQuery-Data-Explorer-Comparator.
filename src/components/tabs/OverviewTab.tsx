'use client';

import type { TableMetadata } from '@/lib/types';
import { formatBytes, formatNumber, formatTimestamp, relativeTime } from '@/lib/format';
import { Badge, Notice, Panel, Stat } from '../ui';

export function OverviewTab({ metadata }: { metadata: TableMetadata }) {
  const { partition } = metadata;
  const avgRowBytes = metadata.rowCount > 0 ? metadata.sizeBytes / metadata.rowCount : 0;

  return (
    <div className="stack">
      <Panel title="Table">
        <div className="stat-grid">
          <Stat label="Rows" value={formatNumber(metadata.rowCount)} />
          <Stat label="Logical size" value={formatBytes(metadata.sizeBytes)} sub={`≈ ${formatBytes(avgRowBytes)} / row`} />
          <Stat label="Columns" value={formatNumber(metadata.columns.length)} />
          <Stat
            label="Last modified"
            value={relativeTime(metadata.lastModifiedAt)}
            sub={formatTimestamp(metadata.lastModifiedAt)}
          />
          <Stat label="Created" value={formatTimestamp(metadata.createdAt)} />
          <Stat label="Type" value={metadata.tableType} />
        </div>

        {metadata.description ? (
          <p className="muted" style={{ marginTop: '1rem' }}>
            {metadata.description}
          </p>
        ) : null}

        {Object.keys(metadata.labels).length > 0 ? (
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            {Object.entries(metadata.labels).map(([key, value]) => (
              <Badge key={key}>
                {key}: {value}
              </Badge>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel title="Partitioning &amp; clustering">
        {partition.field ? (
          <>
            <dl className="kv">
              <dt>Partitioned by</dt>
              <dd>
                <code>{partition.field}</code> ({partition.type ?? 'DAY'})
              </dd>

              <dt>Partition filter</dt>
              <dd>
                {partition.requirePartitionFilter ? (
                  <Badge tone="warn">Required</Badge>
                ) : (
                  <Badge>Optional</Badge>
                )}
              </dd>

              <dt>Partitions</dt>
              <dd>{partition.partitionCount === null ? '—' : formatNumber(partition.partitionCount)}</dd>

              <dt>Range</dt>
              <dd>
                {partition.oldestPartitionId ?? '—'} → {partition.newestPartitionId ?? '—'}
              </dd>

              <dt>Expiration</dt>
              <dd>
                {partition.expirationMs
                  ? `${formatNumber(Math.round(partition.expirationMs / 86_400_000))} days`
                  : 'Never'}
              </dd>

              <dt>Clustered by</dt>
              <dd>
                {partition.clusteringFields.length > 0 ? (
                  partition.clusteringFields.map((field, index) => (
                    <span key={field}>
                      {index > 0 ? ', ' : ''}
                      <code>{field}</code>
                    </span>
                  ))
                ) : (
                  <span className="faint">Not clustered</span>
                )}
              </dd>
            </dl>

            {partition.requirePartitionFilter ? (
              <div style={{ marginTop: '0.85rem' }}>
                <Notice tone="warn">
                  This table requires a partition filter on <code>{partition.field}</code>. Sampling, profiling and
                  comparison all apply the date range from the selector above.
                </Notice>
              </div>
            ) : null}
          </>
        ) : (
          <Notice>
            This table is not partitioned. Queries against it scan the full table, so the byte budget applies
            strictly — profile a few columns at a time.
          </Notice>
        )}
      </Panel>
    </div>
  );
}

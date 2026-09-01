'use client';

import type { TableRef } from '@/lib/types';
import { Panel } from './ui';

export interface CountryEntry {
  country: string;
  ref: TableRef;
}

/**
 * One click per country, jumping straight to
 * `kz-dp-prod.dpp_gold_prod.{country}_dpp_deposit_v2_gold`.
 */
export function CountryShortcut({
  countries,
  onSelect,
  activeRef,
}: {
  countries: CountryEntry[];
  onSelect: (ref: TableRef) => void;
  activeRef: TableRef | null;
}) {
  if (countries.length === 0) return null;

  return (
    <Panel
      title="Country shortcut"
      actions={
        <span className="faint mono" style={{ fontSize: 11 }}>
          kz-dp-prod.dpp_gold_prod.&#123;country&#125;_dpp_deposit_v2_gold
        </span>
      }
    >
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {countries.map((entry) => {
          const active =
            activeRef?.project === entry.ref.project &&
            activeRef?.dataset === entry.ref.dataset &&
            activeRef?.table === entry.ref.table;
          return (
            <button
              key={entry.country}
              type="button"
              className="chip"
              aria-pressed={active}
              onClick={() => onSelect(entry.ref)}
              title={`${entry.ref.project}.${entry.ref.dataset}.${entry.ref.table}`}
            >
              {entry.country}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/** Display formatting shared by the UI and covered by unit tests. */

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : value < 10 ? 2 : 1)} ${units[unit]}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value > 0 && value < 0.01) return '< $0.01';
  return `$${value.toFixed(2)}`;
}

/** Renders an ISO timestamp as `2026-09-01 04:15 UTC`. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((now - then) / 1000);
  const past = seconds >= 0;
  const abs = Math.abs(seconds);
  const units: Array<[number, string]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [2592000, 'day'],
    [31536000, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let divisor = 1;
  for (const [limit, unit] of units) {
    if (abs < limit) {
      const amount = Math.max(1, Math.floor(abs / divisor));
      const plural = amount === 1 ? '' : 's';
      return past ? `${amount} ${unit}${plural} ago` : `in ${amount} ${unit}${plural}`;
    }
    divisor = limit;
  }
  return '—';
}

/** ISO date `n` days before `from`, used for the default comparison window. */
export function isoDaysAgo(days: number, from = new Date()): string {
  const date = new Date(from.getTime());
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Truncates long cell values so one wide column cannot break the table layout. */
export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function cellText(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true };
  if (typeof value === 'object') return { text: truncate(JSON.stringify(value)), isNull: false };
  return { text: truncate(String(value)), isNull: false };
}

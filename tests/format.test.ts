import { describe, expect, it } from 'vitest';
import {
  cellText,
  daysBetween,
  formatBytes,
  formatNumber,
  formatPercent,
  formatTimestamp,
  formatUsd,
  isoDaysAgo,
  relativeTime,
  truncate,
} from '@/lib/format';

describe('number and byte formatting', () => {
  it('groups thousands and handles missing values', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(null)).toBe('—');
  });

  it('scales bytes to binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(41_233_887_744)).toBe('38.4 GiB');
  });

  it('formats sub-cent costs without rounding to zero', () => {
    expect(formatUsd(0.0004)).toBe('< $0.01');
    expect(formatUsd(1.5)).toBe('$1.50');
  });

  it('formats percentages', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('date helpers', () => {
  it('renders timestamps in UTC', () => {
    expect(formatTimestamp('2026-09-01T04:15:22.000Z')).toBe('2026-09-01 04:15 UTC');
    expect(formatTimestamp(null)).toBe('—');
  });

  it('counts an inclusive day span', () => {
    expect(daysBetween('2026-08-01', '2026-08-01')).toBe(1);
    expect(daysBetween('2026-08-01', '2026-08-31')).toBe(31);
  });

  it('walks back a whole number of days', () => {
    expect(isoDaysAgo(7, new Date('2026-09-01T12:00:00Z'))).toBe('2026-08-25');
  });

  it('describes relative time in the past', () => {
    const now = Date.parse('2026-09-01T12:00:00Z');
    expect(relativeTime('2026-09-01T11:00:00Z', now)).toBe('1 hour ago');
    expect(relativeTime('2026-08-30T12:00:00Z', now)).toBe('2 days ago');
  });
});

describe('cell rendering', () => {
  it('marks nullish values', () => {
    expect(cellText(null)).toEqual({ text: 'NULL', isNull: true });
    expect(cellText(undefined).isNull).toBe(true);
  });

  it('serialises objects rather than printing [object Object]', () => {
    expect(cellText({ a: 1 }).text).toBe('{"a":1}');
  });

  it('truncates long values', () => {
    expect(truncate('x'.repeat(200)).length).toBe(120);
    expect(truncate('short')).toBe('short');
  });
});

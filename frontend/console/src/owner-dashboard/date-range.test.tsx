import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  customRange,
  type DatePreset,
  formatRange,
  presetLabel,
  presetRange,
  toUtcWindow,
} from './date-range';
import { DateRangeFilter } from './date-range-filter';

// Tuesday 24 November 2026, late evening UTC.
const NOW = new Date('2026-11-24T23:49:00Z');
const days = (preset: DatePreset) => {
  const { start, end } = presetRange(preset, NOW);
  return [start, end];
};

describe('Overview date presets (UTC days)', () => {
  it('matches the analytics presets for Tue 24 Nov 2026', () => {
    expect(days('today')).toEqual(['2026-11-24', '2026-11-24']);
    expect(days('yesterday')).toEqual(['2026-11-23', '2026-11-23']);
    expect(days('this-week')).toEqual(['2026-11-22', '2026-11-24']);
    expect(days('last-7')).toEqual(['2026-11-17', '2026-11-23']);
    expect(days('last-week')).toEqual(['2026-11-15', '2026-11-21']);
    expect(days('last-28')).toEqual(['2026-10-27', '2026-11-23']);
    expect(days('last-30')).toEqual(['2026-10-25', '2026-11-23']);
    expect(days('this-month')).toEqual(['2026-11-01', '2026-11-24']);
    expect(days('last-month')).toEqual(['2026-10-01', '2026-10-31']);
  });

  it('crosses a year boundary for last month in January', () => {
    const { start, end } = presetRange('last-month', new Date('2027-01-05T10:00:00Z'));
    expect([start, end]).toEqual(['2026-12-01', '2026-12-31']);
  });

  it('turns a range into a half-open UTC window that ends the next midnight', () => {
    expect(toUtcWindow(presetRange('last-28', NOW))).toEqual({
      start_time: '2026-10-27T00:00:00.000Z',
      end_time: '2026-11-24T00:00:00.000Z',
    });
    expect(toUtcWindow(presetRange('today', NOW))).toEqual({
      start_time: '2026-11-24T00:00:00.000Z',
      end_time: '2026-11-25T00:00:00.000Z',
    });
  });
});

describe('Custom date range', () => {
  it('accepts a valid range and rejects reversed, future or impossible dates', () => {
    expect(customRange('2026-07-24', '2026-11-24', NOW)).toEqual({
      preset: 'custom',
      start: '2026-07-24',
      end: '2026-11-24',
    });
    expect(customRange('2026-11-10', '2026-11-01', NOW)).toBeNull();
    expect(customRange('2026-11-01', '2026-11-25', NOW)).toBeNull();
    expect(customRange('2026-02-30', '2026-03-01', NOW)).toBeNull();
    expect(customRange('', '2026-11-01', NOW)).toBeNull();
  });
});

describe('Date range labels', () => {
  it('formats like the analytics picker', () => {
    expect(formatRange(presetRange('last-28', NOW))).toBe('Oct 27 – Nov 23, 2026');
    expect(formatRange(presetRange('today', NOW))).toBe('Nov 24, 2026');
    expect(formatRange({ preset: 'custom', start: '2025-12-30', end: '2026-01-02' })).toBe(
      'Dec 30, 2025 – Jan 2, 2026',
    );
    expect(presetLabel('last-28')).toBe('Last 28 days');
    expect(presetLabel('custom')).toBe('Custom');
  });

  it('shows the chosen preset and dates on a closed filter button', () => {
    const html = renderToStaticMarkup(
      <DateRangeFilter value={presetRange('last-28', NOW)} onApply={() => {}} now={NOW} />,
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Last 28 days');
    expect(html).toContain('Oct 27 – Nov 23, 2026');
  });
});

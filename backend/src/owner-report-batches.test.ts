import { ownerReportMidnight } from '@peekaplate/contracts/owner-report';
import { describe, expect, it } from 'vitest';
import { ownerReportDayWindow } from './owner-report-batches';

describe('San Francisco report window', () => {
  it('includes the prior UTC evening and advances the settled end without moving midnight', () => {
    const eventTime = Date.parse('2026-11-24T04:50:00Z');
    for (const now of ['2026-11-24T04:56:00Z', '2026-11-24T05:16:00Z']) {
      const window = ownerReportDayWindow(new Date(now));
      expect(window.start.toISOString()).toBe('2026-11-23T08:00:00.000Z');
      expect(window.baselineStart.toISOString()).toBe('2026-11-22T08:00:00.000Z');
      expect(window.start.getTime()).toBeLessThanOrEqual(eventTime);
      expect(window.end.getTime()).toBeGreaterThan(eventTime);
      expect(window.end.getTime()).toBe(Date.parse(now) - 60_000);
    }
  });

  it('starts a new local day at midnight even before its first batch settles', () => {
    const { start, end, baselineStart } = ownerReportDayWindow(new Date('2026-11-24T08:00:30Z'));
    expect(start.toISOString()).toBe('2026-11-24T08:00:00.000Z');
    expect(end).toEqual(start);
    expect(baselineStart.toISOString()).toBe('2026-11-23T08:00:00.000Z');
  });

  it.each([
    ['2026-03-08T18:00:00Z', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ['2026-11-01T18:00:00Z', '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
  ])('uses real local midnight on DST day %s', (now, start, next) => {
    expect(ownerReportMidnight(new Date(now)).toISOString()).toBe(start);
    expect(ownerReportMidnight(new Date(now), 1).toISOString()).toBe(next);
    expect(ownerReportMidnight(new Date(next), -1).toISOString()).toBe(start);
  });
});

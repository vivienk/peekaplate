import { describe, expect, it } from 'vitest';
import { samePeriod } from './OwnerWorkspace';

const report = { start_time: '2026-10-19T07:00:00.000Z', end_time: '2026-10-20T07:00:00.000Z' };

describe('AI analysis period versus the report on screen', () => {
  it('matches the same instants however they are written', () => {
    expect(samePeriod(report, { start: '2026-10-19T07:00:00Z', end: '2026-10-20T07:00:00Z' })).toBe(
      true,
    );
  });

  it('does not match when the start or the end differs', () => {
    expect(samePeriod(report, { start: '2026-10-19T06:00:00Z', end: '2026-10-20T07:00:00Z' })).toBe(
      false,
    );
    expect(samePeriod(report, { start: '2026-10-19T07:00:00Z', end: '2026-10-20T08:00:00Z' })).toBe(
      false,
    );
    expect(samePeriod(report, { start: '2026-11-11T12:00:00Z', end: '2026-11-12T12:00:00Z' })).toBe(
      false,
    );
  });

  it('never matches an unreadable date', () => {
    expect(
      samePeriod(
        { start_time: 'not a date', end_time: 'not a date' },
        { start: 'not a date', end: 'not a date' },
      ),
    ).toBe(false);
  });
});

describe('naming two periods for the owner', () => {
  it('uses dates when they differ, and exact UTC times when the dates read the same', async () => {
    const { periodPair } = await import('./OwnerWorkspace');
    const report = { start_time: '2026-10-19T07:00:00Z', end_time: '2026-10-20T07:00:00Z' };
    const byDate = periodPair(report, {
      start: '2026-11-11T12:00:00Z',
      end: '2026-11-12T12:00:00Z',
    });
    expect(byDate.report).not.toBe(byDate.analysis);
    expect(byDate.analysis).toMatch(/Nov 11\s*–\s*12, 2026/);
    const rolling = periodPair(report, {
      start: '2026-10-19T07:00:25Z',
      end: '2026-10-20T07:00:25Z',
    });
    expect(rolling.report).not.toBe(rolling.analysis);
    expect(rolling.analysis).toMatch(/Oct 19, 7:00:25\s*AM UTC/);
  });
});

import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { readOwnerReport } from './owner-report';

const venue = '00000000-0000-4000-8000-000000000123';
const now = new Date('2026-11-17T12:00:00Z');
const row = (period: string, overrides = {}) => ({
  period,
  menu_sessions: 20,
  dish_opens: 25,
  open_sessions: 15,
  timed_sessions: 10,
  average_active_seconds: 12,
  has_small_dish: false,
  has_small_timed_dish: false,
  ...overrides,
});
async function run(rows = [row('current'), row('baseline')], permission = 'owner') {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('staff_membership')
      ? [{ permission }]
      : sql.includes('owner_summary.v1')
        ? rows
        : [],
  }));
  const report = await readOwnerReport(
    { query } as unknown as Client,
    'actor',
    venue,
    now,
    'synthetic',
    { includeSummary: true, trafficClass: 'test' },
  );
  return { report: OwnerDishReportSchema.parse(report), query };
}
describe('owner report summary', () => {
  it('returns clipped UTC daily openings and hides the entire series and totals for a small bucket', async () => {
    const buckets = [
      {
        start_time: '2026-11-16T12:00:00.000Z',
        end_time: '2026-11-17T00:00:00.000Z',
        opens: 12,
        sessions: 10,
      },
      {
        start_time: '2026-11-17T00:00:00.000Z',
        end_time: '2026-11-17T12:00:00.000Z',
        opens: 13,
        sessions: 10,
      },
    ];
    const baseline = buckets.map((bucket) => ({
      ...bucket,
      start_time: new Date(Date.parse(bucket.start_time) - 86400000).toISOString(),
      end_time: new Date(Date.parse(bucket.end_time) - 86400000).toISOString(),
    }));
    const normal = await run([
      row('current', { daily_buckets: buckets }),
      row('baseline', { daily_buckets: baseline }),
    ]);
    expect(normal.report.summary?.daily_opens?.current.map((bucket) => bucket.opens)).toEqual([
      { value: 12, status: 'NORMAL' },
      { value: 13, status: 'NORMAL' },
    ]);
    expect(normal.report.summary?.daily_opens?.current[0]?.start_time).toBe(buckets[0]!.start_time);
    const protectedReport = await run([
      row('current', { daily_buckets: [buckets[0], { ...buckets[1], sessions: 9 }] }),
      row('baseline', { daily_buckets: baseline }),
    ]);
    expect(protectedReport.report.summary?.current.dish_opens).toEqual({
      value: null,
      status: 'SUPPRESSED',
    });
    expect(
      protectedReport.report.summary?.daily_opens?.current.every(
        (bucket) => bucket.opens.value === null && bucket.opens.status === 'SUPPRESSED',
      ),
    ).toBe(true);
  });
  it('adds exact current/baseline windows and observed aggregates, never unsupported zeros', async () => {
    const { report, query } = await run();
    expect(report.summary?.periods).toEqual({
      current: { start_time: '2026-11-16T12:00:00.000Z', end_time: '2026-11-17T12:00:00.000Z' },
      baseline: { start_time: '2026-11-15T12:00:00.000Z', end_time: '2026-11-16T12:00:00.000Z' },
    });
    expect(report.summary?.current).toEqual({
      menu_sessions: { value: 20, status: 'NORMAL' },
      dish_opens: { value: 25, status: 'NORMAL' },
      avg_interaction_time_seconds: { value: 12, status: 'NORMAL' },
      portion_previews_shown: { value: null, status: 'MISSING' },
      verified_orders: { value: null, status: 'MISSING' },
    });
    expect(report.report_metadata.freshness.is_stale).toBeNull();
    const sql = query.mock.calls.find(([sql]) => sql.includes('owner_summary.v1'))![0];
    expect(sql).toContain('owner_test_observation_v1');
    expect(sql).not.toContain('owner_observation_v1');
    expect(sql).toContain('COUNT(DISTINCT session_id)');
    expect(sql).toContain('GROUP BY period, session_id, dish_id, opening_id');
    expect(query.mock.calls.map(([sql]) => sql)).toContain(
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
  });
  it('uses independent floors and preserves measured zero without inventing missing measurements', async () => {
    const { report } = await run([
      row('current', { average_active_seconds: 0 }),
      row('baseline', {
        menu_sessions: 9,
        open_sessions: 9,
        timed_sessions: 0,
        average_active_seconds: null,
      }),
    ]);
    expect(report.summary?.current.avg_interaction_time_seconds).toEqual({
      value: 0,
      status: 'VALID_ZERO',
    });
    expect(report.summary?.baseline.menu_sessions.status).toBe('SUPPRESSED');
    expect(report.summary?.baseline.dish_opens.status).toBe('SUPPRESSED');
    expect(report.summary?.baseline.avg_interaction_time_seconds).toEqual({
      value: null,
      status: 'NOT_MEASURABLE',
    });
  });
  it('complementarily suppresses aggregates containing protected dish subsets', async () => {
    const { report } = await run([
      row('current', { has_small_dish: true }),
      row('baseline', { has_small_timed_dish: true }),
    ]);
    for (const key of ['menu_sessions', 'dish_opens', 'avg_interaction_time_seconds'] as const) {
      expect(report.summary?.current[key]).toEqual({ value: null, status: 'SUPPRESSED' });
      expect(report.summary?.baseline[key]).toEqual({ value: null, status: 'SUPPRESSED' });
    }
  });
  it('checks owner membership before summary access', async () => {
    await expect(run(undefined, 'viewer')).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('does not turn ten menu visits without openings into a measured opening zero', async () => {
    const { report } = await run([
      row('current', {
        menu_sessions: 10,
        dish_opens: 0,
        open_sessions: 0,
        timed_sessions: 0,
        average_active_seconds: null,
      }),
      row('baseline'),
    ]);
    expect(report.summary?.current.menu_sessions).toEqual({ value: 10, status: 'NORMAL' });
    expect(report.summary?.current.dish_opens).toEqual({ value: null, status: 'NOT_MEASURABLE' });
    expect(report.summary?.current.avg_interaction_time_seconds).toEqual({
      value: null,
      status: 'NOT_MEASURABLE',
    });
  });
  it('rejects invalid period bindings and unsupported fabricated metrics', async () => {
    const { report } = await run();
    const invalid = structuredClone(report);
    invalid.summary!.periods.current.end_time = '2026-11-18T12:00:00.000Z';
    expect(OwnerDishReportSchema.safeParse(invalid).success).toBe(false);
    const unsupported = structuredClone(report);
    Object.assign(unsupported.summary!.current, {
      verified_orders: { value: 0, status: 'VALID_ZERO' },
    });
    expect(OwnerDishReportSchema.safeParse(unsupported).success).toBe(false);
    const small = structuredClone(report);
    small.summary!.current.menu_sessions = { value: 1, status: 'NORMAL' };
    expect(OwnerDishReportSchema.safeParse(small).success).toBe(false);
  });
});

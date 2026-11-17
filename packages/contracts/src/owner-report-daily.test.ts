import { expect, it } from 'vitest';
import { OwnerReportSummarySchema } from './owner-report';

const missing = { value: null, status: 'MISSING' };
const metrics = {
  menu_sessions: missing,
  dish_opens: missing,
  avg_interaction_time_seconds: missing,
  portion_previews_shown: missing,
  verified_orders: missing,
};
const bucket = (start: string, end: string) => ({
  start_time: start,
  end_time: end,
  opens: missing,
});
const summary = () => ({
  periods: {
    current: { start_time: '2026-11-16T12:00:00Z', end_time: '2026-11-17T12:00:00Z' },
    baseline: { start_time: '2026-11-15T12:00:00Z', end_time: '2026-11-16T12:00:00Z' },
  },
  current: structuredClone(metrics),
  baseline: structuredClone(metrics),
  daily_opens: {
    current: [
      bucket('2026-11-16T12:00:00Z', '2026-11-17T00:00:00Z'),
      bucket('2026-11-17T00:00:00Z', '2026-11-17T12:00:00Z'),
    ],
    baseline: [
      bucket('2026-11-15T12:00:00Z', '2026-11-16T00:00:00Z'),
      bucket('2026-11-16T00:00:00Z', '2026-11-16T12:00:00Z'),
    ],
  },
});
it('accepts only complete clipped UTC buckets without exposing cohort counts', () => {
  expect(OwnerReportSummarySchema.safeParse(summary()).success).toBe(true);
  const shifted = summary();
  shifted.daily_opens.current[0]!.end_time = '2026-11-17T01:00:00Z';
  expect(OwnerReportSummarySchema.safeParse(shifted).success).toBe(false);
  const leaked = summary();
  Object.assign(leaked.daily_opens.current[0]!, { sessions: 2 });
  expect(OwnerReportSummarySchema.safeParse(leaked).success).toBe(false);
});
it('rejects published totals or another visible bucket alongside a protected bucket', () => {
  const protectedSummary = summary();
  protectedSummary.daily_opens.current[0]!.opens.status = 'SUPPRESSED';
  Object.assign(protectedSummary.current.dish_opens, { value: 25, status: 'NORMAL' });
  expect(OwnerReportSummarySchema.safeParse(protectedSummary).success).toBe(false);
  protectedSummary.current = structuredClone(metrics);
  Object.assign(protectedSummary.daily_opens.current[1]!.opens, { value: 15, status: 'NORMAL' });
  expect(OwnerReportSummarySchema.safeParse(protectedSummary).success).toBe(false);
});

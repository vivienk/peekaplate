
import { OwnerDishReportSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { readOwnerReport } from './owner-report';

const venueId = 'e2a66159-bd14-44cb-8217-36d001a12676';
const dishId = '45806808-4376-46ff-912b-ab8a5519881a';
const now = new Date('2026-11-12T10:00:00Z');

type Metric = {
  value: number | null;
  status: string;
};

type ReportDish = {
  evidence_state: string;
  metrics: Record<string, Metric>;
};

function makeRow(sessions: number, overrides: Record<string, unknown> = {}) {
  return {
    dish_id: dishId,
    dish_name: 'DATA-12 isolated synthetic dish',
    total_sessions: sessions,
    exposed_open_sessions: sessions,
    open_eligible_sessions: sessions,
    total_openings: sessions,
    timed_openings: sessions,
    engaged_sessions: sessions,
    saved_sessions: sessions,
    timed_sessions: sessions,
    average_active_seconds: 12,
    last_event_ingested_at: now,
    ...overrides,
  };
}

function fakeClient(row: Record<string, unknown>): Client {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('app_private.staff_membership')) {
        return { rows: [{ permission: 'owner' }] };
      }
      if (sql.includes('app_private.owner_observation_v1')) {
        return { rows: [row] };
      }
      return { rows: [] };
    }),
  } as unknown as Client;
}

async function getDish(
  sessions: number,
  overrides: Record<string, unknown> = {},
): Promise<ReportDish> {
  const result = await readOwnerReport(
    fakeClient(makeRow(sessions, overrides)),
    'data12-test-owner',
    venueId,
    now,
    'synthetic',
  );

  expect(OwnerDishReportSchema.safeParse(result).success).toBe(true);

  const report = result as { dishes: ReportDish[] };
  expect(report.dishes).toHaveLength(1);
  return report.dishes[0]!;
}

describe('DATA-12 isolated owner-report privacy thresholds', () => {
  it('suppresses all behavioral metrics at 9 sessions', async () => {
    const dish = await getDish(9);

    expect(dish.evidence_state).toBe('SUPPRESSED');

    for (const metric of Object.values(dish.metrics)) {
      expect(metric.value).toBeNull();
      expect(metric.status).toBe('SUPPRESSED');
    }
  });

  it('allows eligible metrics at exactly 10 sessions', async () => {
    const dish = await getDish(10);

    expect(dish.evidence_state).toBe('NORMAL');
    expect(dish.metrics.active_sessions).toEqual({
      value: 10,
      status: 'NORMAL',
    });

    for (const name of [
      'open_rate',
      'engagement_rate',
      'save_rate',
      'timing_coverage',
    ]) {
      expect(dish.metrics[name]).toEqual({
        value: 1,
        status: 'NORMAL',
      });
    }

    expect(dish.metrics.avg_interaction_time_seconds).toEqual({
      value: 12,
      status: 'NORMAL',
    });
  });

  it('preserves eligible metric calculations at 11 sessions', async () => {
    const dish = await getDish(11, {
      exposed_open_sessions: 10,
      engaged_sessions: 8,
      saved_sessions: 0,
      timed_openings: 10,
      timed_sessions: 10,
    });

    expect(dish.evidence_state).toBe('NORMAL');
    expect(dish.metrics.active_sessions).toEqual({
      value: 11,
      status: 'NORMAL',
    });
    expect(dish.metrics.open_rate).toEqual({
      value: 0.909,
      status: 'NORMAL',
    });
    expect(dish.metrics.engagement_rate).toEqual({
      value: 0.727,
      status: 'NORMAL',
    });
    expect(dish.metrics.save_rate).toEqual({
      value: 0,
      status: 'VALID_ZERO',
    });
    expect(dish.metrics.timing_coverage).toEqual({
      value: 0.909,
      status: 'NORMAL',
    });
    expect(dish.metrics.avg_interaction_time_seconds).toEqual({
      value: 12,
      status: 'NORMAL',
    });
  });

  it('suppresses engagement and timing when eligible cohorts are below 10', async () => {
    const dish = await getDish(11, {
      exposed_open_sessions: 9,
      open_eligible_sessions: 9,
      timed_sessions: 9,
      timed_openings: 9,
    });

    expect(dish.evidence_state).toBe('NORMAL');

    for (const name of [
      'engagement_rate',
      'timing_coverage',
      'avg_interaction_time_seconds',
    ]) {
      expect(dish.metrics[name]?.value).toBeNull();
      expect(dish.metrics[name]?.status).toBe('SUPPRESSED');
    }
  });

  it('distinguishes valid zero from not measurable', async () => {
    const dish = await getDish(10, {
      exposed_open_sessions: 0,
      open_eligible_sessions: 0,
      total_openings: 0,
      timed_openings: 0,
      engaged_sessions: 0,
      saved_sessions: 0,
      timed_sessions: 0,
      average_active_seconds: null,
    });

    expect(dish.metrics.open_rate).toEqual({
      value: 0,
      status: 'VALID_ZERO',
    });
    expect(dish.metrics.engagement_rate).toEqual({
      value: null,
      status: 'NOT_MEASURABLE',
    });
    expect(dish.metrics.avg_interaction_time_seconds).toEqual({
      value: null,
      status: 'NOT_MEASURABLE',
    });
  });
});

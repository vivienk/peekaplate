import { OwnerDishReportSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { readComparisonReport } from './comparison-report';
import { readOwnerReport } from './owner-report';

const VENUE_ID = '00000000-0000-4000-8000-000000000123';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-13T12:00:00.000Z');

function createOwnerReportClient(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (text: string) => {
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (normalized.includes('app_private.staff_membership')) {
      return { rows: [{ permission: 'owner' }] };
    }
    if (normalized.includes('app_private.owner_observation_v1')) {
      return { rows };
    }
    return { rows: [] };
  });
  return { query } as unknown as Client;
}

describe('DATA-12 reconciliation: Uneeza approved synthetic fixtures vs #107/#134/#152 report outputs', () => {
  it('reconciles D06-PRIVACY-09, D06-PRIVACY-10, D06-PRIVACY-11, and D06-PRIVACY-REPEAT session boundaries', async () => {
    const rows = [
      {
        dish_id: '00000000-0000-4000-8000-000000000009',
        dish_name: 'D06-PRIVACY-09 Dish',
        total_sessions: 9,
        exposed_open_sessions: 9,
        open_eligible_sessions: 9,
        total_openings: 9,
        timed_openings: 9,
        engaged_sessions: 9,
        saved_sessions: 9,
        timed_sessions: 9,
        average_active_seconds: 12,
        last_event_ingested_at: NOW,
      },
      {
        dish_id: '00000000-0000-4000-8000-000000000010',
        dish_name: 'D06-PRIVACY-10 Dish',
        total_sessions: 10,
        exposed_open_sessions: 10,
        open_eligible_sessions: 10,
        total_openings: 10,
        timed_openings: 10,
        engaged_sessions: 10,
        saved_sessions: 10,
        timed_sessions: 10,
        average_active_seconds: 12,
        last_event_ingested_at: NOW,
      },
      {
        dish_id: '00000000-0000-4000-8000-000000000011',
        dish_name: 'D06-PRIVACY-11 Dish',
        total_sessions: 11,
        exposed_open_sessions: 10,
        open_eligible_sessions: 11,
        total_openings: 10,
        timed_openings: 10,
        engaged_sessions: 8,
        saved_sessions: 0,
        timed_sessions: 10,
        average_active_seconds: 12,
        last_event_ingested_at: NOW,
      },
      {
        dish_id: '00000000-0000-4000-8000-000000000001',
        dish_name: 'D06-PRIVACY-REPEAT Dish',
        total_sessions: 1,
        exposed_open_sessions: 1,
        open_eligible_sessions: 1,
        total_openings: 10,
        timed_openings: 10,
        engaged_sessions: 1,
        saved_sessions: 1,
        timed_sessions: 1,
        average_active_seconds: 12,
        last_event_ingested_at: NOW,
      },
    ];

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(createOwnerReportClient(rows), ACTOR_ID, VENUE_ID, NOW, 'synthetic'),
    );

    expect(report.report_metadata.freshness.is_stale).toBeNull();
    expect(report.report_metadata.coverage.total_dishes_monitored).toBe(4);
    expect(report.report_metadata.coverage.measurable_dishes_count).toBe(2);

    const dish09 = report.dishes.find((d) => d.dish_id === '00000000-0000-4000-8000-000000000009')!;
    expect(dish09.evidence_state).toBe('SUPPRESSED');
    expect(dish09.metrics.active_sessions.value).toBeNull();
    expect(dish09.metrics.timing_coverage.status).toBe('SUPPRESSED');

    const dish10 = report.dishes.find((d) => d.dish_id === '00000000-0000-4000-8000-000000000010')!;
    expect(dish10.evidence_state).toBe('NORMAL');
    expect(dish10.metrics.active_sessions.value).toBe(10);
    expect(dish10.metrics.timing_coverage).toEqual({ value: 1, status: 'NORMAL' });

    const dish11 = report.dishes.find((d) => d.dish_id === '00000000-0000-4000-8000-000000000011')!;
    expect(dish11.evidence_state).toBe('NORMAL');
    expect(dish11.metrics.save_rate).toEqual({ value: 0, status: 'VALID_ZERO' });
    expect(dish11.metrics.timing_coverage).toEqual({ value: 1, status: 'NORMAL' });

    const dishRepeat = report.dishes.find(
      (d) => d.dish_id === '00000000-0000-4000-8000-000000000001',
    )!;
    expect(dishRepeat.evidence_state).toBe('SUPPRESSED');
    expect(dishRepeat.metrics.active_sessions.value).toBeNull();
  });

  it('reconciles timing coverage coupled suppression and NOT_MEASURABLE states', async () => {
    const rows = [
      {
        dish_id: '00000000-0000-4000-8000-000000000021',
        dish_name: 'Sub-floor Open Cohort Dish',
        total_sessions: 11,
        exposed_open_sessions: 9,
        open_eligible_sessions: 9,
        total_openings: 9,
        timed_openings: 9,
        engaged_sessions: 9,
        saved_sessions: 4,
        timed_sessions: 9,
        average_active_seconds: 14,
        last_event_ingested_at: NOW,
      },
      {
        dish_id: '00000000-0000-4000-8000-000000000022',
        dish_name: 'Zero Openings Timing Dish',
        total_sessions: 11,
        exposed_open_sessions: 0,
        open_eligible_sessions: 11,
        total_openings: 0,
        timed_openings: 0,
        engaged_sessions: 0,
        saved_sessions: 0,
        timed_sessions: 0,
        average_active_seconds: null,
        last_event_ingested_at: NOW,
      },
    ];

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(createOwnerReportClient(rows), ACTOR_ID, VENUE_ID, NOW, 'synthetic'),
    );

    const subFloorOpen = report.dishes.find(
      (d) => d.dish_id === '00000000-0000-4000-8000-000000000021',
    )!;
    expect(subFloorOpen.evidence_state).toBe('NORMAL');
    expect(subFloorOpen.metrics.open_rate).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(subFloorOpen.metrics.timing_coverage).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(subFloorOpen.metrics.engagement_rate).toEqual({ value: null, status: 'SUPPRESSED' });

    const zeroOpenings = report.dishes.find(
      (d) => d.dish_id === '00000000-0000-4000-8000-000000000022',
    )!;
    expect(zeroOpenings.metrics.open_rate).toEqual({ value: 0, status: 'VALID_ZERO' });
    expect(zeroOpenings.metrics.timing_coverage).toEqual({ value: null, status: 'NOT_MEASURABLE' });
    expect(zeroOpenings.metrics.avg_interaction_time_seconds).toEqual({
      value: null,
      status: 'NOT_MEASURABLE',
    });
  });

  it('reconciles comparison attribution window suppression (INSUFFICIENT when below 10 sessions)', async () => {
    const query = vi.fn(async (text: string) => {
      const normalized = text.trim().replace(/\s+/g, ' ');
      if (normalized.includes('app_private.staff_membership')) {
        return { rows: [{ permission: 'owner' }] };
      }
      if (normalized.includes('app_private.owner_comparison_v1')) {
        return {
          rows: [
            {
              dish_id: '00000000-0000-4000-8000-000000000031',
              dish_name: 'Suppressed Comparison Dish',
              baseline_total_sessions: 12,
              baseline_exposed_open_sessions: 8,
              baseline_open_eligible_sessions: 12,
              baseline_engaged_sessions: 6,
              baseline_saved_sessions: 3,
              current_total_sessions: 8,
              current_exposed_open_sessions: 4,
              current_open_eligible_sessions: 8,
              current_engaged_sessions: 2,
              current_saved_sessions: 1,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const comparisonReport = await readComparisonReport(
      { query } as unknown as Client,
      ACTOR_ID,
      VENUE_ID,
      '2026-11-07T00:00:00.000Z',
      '2026-11-13T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      '2026-11-07T00:00:00.000Z',
    );

    const dish = comparisonReport.dishes!;
    expect(dish.metrics.open_rate.status).toBe('INSUFFICIENT');
    expect(dish.metrics.open_rate.current_value).toBeNull();
    expect(dish.metrics.open_rate.delta).toBeNull();
  });
});

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
        // D06-PRIVACY-09: 9 distinct eligible sessions -> SUPPRESSED
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
        // D06-PRIVACY-10: 10 distinct eligible sessions -> NORMAL
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
        // D06-PRIVACY-11: 11 distinct eligible sessions -> NORMAL
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
        // D06-PRIVACY-REPEAT: 10 events from 1 distinct session -> distinct_eligible_sessions = 1 -> SUPPRESSED
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

    // Null-freshness abstention on current develop (#107/#152)
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
        // 11 total sessions, but only 9 open_eligible_sessions -> timing_coverage & engagement_rate SUPPRESSED
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
        // 11 total sessions, 11 open_eligible_sessions, but 0 openings -> timing_coverage NOT_MEASURABLE
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
    expect(subFloorOpen.metrics.open_rate.status).toBe('NORMAL');
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

  it('reconciles comparison attribution and PR #134 coupled open_rate suppression', async () => {
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
              total_sessions: 12,
              exposed_open_sessions: 8,
              comparison_eligible_sessions: 8,
              compared_sessions: 4,
              last_event_ingested_at: NOW,
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
      NOW,
      'synthetic',
    );

    const dish = comparisonReport.dishes[0]!;
    // PR #134 coupled suppression: comparison_eligible_sessions < 10 suppresses both comparison_rate and open_rate
    expect(dish.metrics.comparison_rate).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(dish.metrics.open_rate).toEqual({ value: null, status: 'SUPPRESSED' });
  });
});

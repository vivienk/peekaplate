import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { PreparedStorage } from './owner-prepare';
import { readOwnerReport } from './owner-report';
import { serializeOwnerReportCsv } from './owner-report-export';

const VENUE_ID = '00000000-0000-4000-8000-000000000717';
const ACTOR_ID = '00000000-0000-4000-8000-000000000701';
const PUB_ID = '11111111-1111-4111-8111-111111111111';
const MENU_ID = '11111111-1111-4111-8111-111111111112';
const MENU_REV_ID = '11111111-1111-4111-8111-111111111113';
const DISH_IDS = [
  '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222202',
  '22222222-2222-4222-8222-222222222203',
  '22222222-2222-4222-8222-222222222204',
  '22222222-2222-4222-8222-222222222205',
];

function memoryStorage(): PreparedStorage {
  const objects = new Map<string, ArrayBuffer>();
  return {
    async get(key: string) {
      const data = objects.get(key);
      if (!data) return null;
      return {
        async arrayBuffer() {
          return data;
        },
      } as unknown as Awaited<ReturnType<PreparedStorage['get']>>;
    },
    async put(key: string, value: ArrayBuffer) {
      objects.set(key, value);
      return { key } as unknown as Awaited<ReturnType<PreparedStorage['put']>>;
    },
  };
}

describe('DATA-17 November 23 production batch reconciliation regression', () => {
  it('explains 10 venue-wide dish_opens alongside 0 measurable dishes when each dish has < 10 exposed visits', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM app_private.staff_membership')) {
        return { rows: [{ permission: 'owner' }] };
      }
      if (sql.includes('SELECT DISTINCT obs.authorized_publication_id')) {
        return { rows: [] };
      }
      if (sql.includes('FROM dish_metrics metrics')) {
        const endIso = params?.[2] instanceof Date ? params[2].toISOString() : '';
        if (endIso !== '2026-11-23T17:50:00.000Z') {
          return { rows: [] };
        }
        // Five dishes (including Avocado Toast), each below the 10-session privacy floor.
        return {
          rows: [
            {
              dish_id: DISH_IDS[0],
              dish_name: 'Avocado Toast',
              total_sessions: '4',
              exposed_open_sessions: '2',
              open_eligible_sessions: '3',
              engaged_sessions: '1',
              saved_sessions: '1',
              timed_sessions: '2',
              last_event_ingested_at: '2026-11-23T17:48:00.000Z',
              average_active_seconds: '11.5',
              total_openings: '3',
              timed_openings: '2',
              timed_opening_sessions: '2',
              untimed_opening_sessions: '1',
            },
            {
              dish_id: DISH_IDS[1],
              dish_name: 'Salmon Poke Bowl',
              total_sessions: '3',
              exposed_open_sessions: '2',
              open_eligible_sessions: '2',
              engaged_sessions: '1',
              saved_sessions: '0',
              timed_sessions: '1',
              last_event_ingested_at: '2026-11-23T17:49:00.000Z',
              average_active_seconds: '9.0',
              total_openings: '3',
              timed_openings: '1',
              timed_opening_sessions: '1',
              untimed_opening_sessions: '1',
            },
            {
              dish_id: DISH_IDS[2],
              dish_name: 'Harvest Power Bowl',
              total_sessions: '2',
              exposed_open_sessions: '1',
              open_eligible_sessions: '2',
              engaged_sessions: '0',
              saved_sessions: '0',
              timed_sessions: '1',
              last_event_ingested_at: '2026-11-23T17:49:10.000Z',
              average_active_seconds: '6.0',
              total_openings: '2',
              timed_openings: '1',
              timed_opening_sessions: '1',
              untimed_opening_sessions: '1',
            },
            {
              dish_id: DISH_IDS[3],
              dish_name: 'Classic Eggs Benedict',
              total_sessions: '1',
              exposed_open_sessions: '1',
              open_eligible_sessions: '1',
              engaged_sessions: '0',
              saved_sessions: '0',
              timed_sessions: '0',
              last_event_ingested_at: '2026-11-23T17:49:20.000Z',
              average_active_seconds: null,
              total_openings: '1',
              timed_openings: '0',
              timed_opening_sessions: '0',
              untimed_opening_sessions: '1',
            },
            {
              dish_id: DISH_IDS[4],
              dish_name: 'Garden Avocado Salad',
              total_sessions: '1',
              exposed_open_sessions: '0',
              open_eligible_sessions: '1',
              engaged_sessions: '0',
              saved_sessions: '0',
              timed_sessions: '0',
              last_event_ingested_at: '2026-11-23T17:49:30.000Z',
              average_active_seconds: null,
              total_openings: '1',
              timed_openings: '0',
              timed_opening_sessions: '0',
              untimed_opening_sessions: '1',
            },
          ],
        };
      }
      if (sql.includes('/* owner_summary.v1 */')) {
        const startDate =
          params?.[1] instanceof Date ? params[1] : new Date('2026-11-23T17:45:00.000Z');
        const endDate =
          params?.[2] instanceof Date ? params[2] : new Date('2026-11-23T17:50:00.000Z');
        const baselineStart = new Date(
          startDate.getTime() - (endDate.getTime() - startDate.getTime()),
        );
        const isCurrentBatch = endDate.toISOString() === '2026-11-23T17:50:00.000Z';
        return {
          rows: [
            {
              period: 'current',
              daily_buckets: [
                {
                  start_time: startDate.toISOString(),
                  end_time: endDate.toISOString(),
                  opens: isCurrentBatch ? 10 : 0,
                  sessions: isCurrentBatch ? 7 : 0,
                },
              ],
              menu_sessions: isCurrentBatch ? '8' : '0',
              dish_opens: isCurrentBatch ? '10' : '0',
              open_sessions: isCurrentBatch ? '7' : '0',
              timed_sessions: isCurrentBatch ? '4' : '0',
              average_active_seconds: isCurrentBatch ? '9.5' : null,
              has_small_dish: isCurrentBatch,
              has_small_timed_dish: isCurrentBatch,
            },
            {
              period: 'baseline',
              daily_buckets: [
                {
                  start_time: baselineStart.toISOString(),
                  end_time: startDate.toISOString(),
                  opens: 0,
                  sessions: 0,
                },
              ],
              menu_sessions: '0',
              dish_opens: '0',
              open_sessions: '0',
              timed_sessions: '0',
              average_active_seconds: null,
              has_small_dish: false,
              has_small_timed_dish: false,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const client = { query } as unknown as Client;
    const now = new Date('2026-11-23T17:51:30.000Z');
    const raw = await readOwnerReport(client, ACTOR_ID, VENUE_ID, now, 'production', {
      includeSummary: true,
      readTodayEvents: async () => [],
      productionPublications: {
        storage: memoryStorage(),
        origin: 'https://api.peekaplate.app',
      },
    });
    const report = OwnerDishReportSchema.parse(raw);

    // Batch window is 17:45:00Z - 17:50:00Z (with 60s settle delay).
    expect(report.report_metadata.calculation_version).toBe('production.batch.v1');
    expect(report.report_metadata.date_window.start_time).toBe('2026-11-23T17:45:00.000Z');
    expect(report.report_metadata.date_window.end_time).toBe('2026-11-23T17:50:00.000Z');
    expect(report.report_metadata.freshness.is_stale).toBeNull();
    expect(report.report_metadata.freshness.last_event_ingested_at).toBeNull();

    // Per-dish privacy floor omits all 5 dishes (< 10 exposed visits each).
    expect(report.report_metadata.coverage.measurable_dishes_count).toBe(0);
    expect(report.report_metadata.coverage.total_dishes_monitored).toBe(0);
    expect(report.report_metadata.report_status).toBe('EMPTY');
    expect(report.dishes).toEqual([]);

    // Venue-wide Overview still shows the 10 captured dish opens while protecting small dish cohorts.
    expect(report.summary?.current.dish_opens).toEqual({ value: 10, status: 'NORMAL' });
    expect(report.summary?.current.menu_sessions).toEqual({ value: 8, status: 'NORMAL' });
    expect(report.summary?.current.avg_interaction_time_seconds).toEqual({
      value: null,
      status: 'MISSING',
    });
    expect(report.summary?.current.verified_orders).toEqual({ value: null, status: 'MISSING' });
    expect(report.summary?.current.portion_previews_shown).toEqual({
      value: null,
      status: 'MISSING',
    });

    // Ensure CSV export never turns empty/suppressed report into numeric zeros.
    const csv = serializeOwnerReportCsv(report);
    expect(csv.trim().split('\n')).toHaveLength(1);
    expect(MENU_ID).toBeTruthy();
    expect(MENU_REV_ID).toBeTruthy();
    expect(PUB_ID).toBeTruthy();
  });

  it('preserves VALID_ZERO vs NOT_MEASURABLE vs SUPPRESSED and never pairs direct opens without exposures', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM app_private.staff_membership')) {
        return { rows: [{ permission: 'owner' }] };
      }
      if (sql.includes('FROM dish_metrics metrics')) {
        return {
          rows: [
            {
              dish_id: DISH_IDS[0],
              dish_name: 'Avocado Toast',
              total_sessions: '12',
              // 0 exposed+opened sessions -> open_rate is VALID_ZERO (0), even though 10 direct opens occurred.
              exposed_open_sessions: '0',
              open_eligible_sessions: '10',
              engaged_sessions: '10',
              saved_sessions: '0',
              timed_sessions: '0',
              last_event_ingested_at: '2026-11-23T17:48:00.000Z',
              average_active_seconds: null,
              total_openings: '10',
              timed_openings: '0',
              timed_opening_sessions: '0',
              untimed_opening_sessions: '10',
            },
            {
              dish_id: DISH_IDS[1],
              dish_name: 'Salmon Poke Bowl',
              total_sessions: '9',
              exposed_open_sessions: '5',
              open_eligible_sessions: '5',
              engaged_sessions: '2',
              saved_sessions: '1',
              timed_sessions: '3',
              last_event_ingested_at: '2026-11-23T17:48:30.000Z',
              average_active_seconds: '10.0',
              total_openings: '5',
              timed_openings: '3',
              timed_opening_sessions: '3',
              untimed_opening_sessions: '2',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const client = { query } as unknown as Client;
    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(
        client,
        ACTOR_ID,
        VENUE_ID,
        new Date('2026-11-23T17:51:30.000Z'),
        'production',
      ),
    );

    expect(report.report_metadata.coverage.measurable_dishes_count).toBe(1);
    const avocado = report.dishes.find((d) => d.dish_id === DISH_IDS[0]);
    const salmon = report.dishes.find((d) => d.dish_id === DISH_IDS[1]);
    expect(avocado?.metrics.open_rate).toEqual({ value: 0, status: 'VALID_ZERO' });
    expect(avocado?.metrics.save_rate).toEqual({ value: 0, status: 'VALID_ZERO' });
    expect(avocado?.metrics.avg_interaction_time_seconds).toEqual({
      value: null,
      status: 'NOT_MEASURABLE',
    });
    expect(avocado?.metrics.timing_coverage).toEqual({ value: 0, status: 'VALID_ZERO' });
    expect(salmon?.evidence_state).toBe('SUPPRESSED');
    expect(salmon?.metrics.active_sessions).toEqual({ value: null, status: 'SUPPRESSED' });

    const csv = serializeOwnerReportCsv(report);
    const salmonDishId = DISH_IDS[1] ?? '';
    const salmonLine = csv.split('\n').find((line) => line.includes(salmonDishId));
    expect(salmonLine).toContain('SUPPRESSED');
    expect(salmonLine).not.toContain(',0,');
  });
});

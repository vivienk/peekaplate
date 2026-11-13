// Demo data. An owner_report.v1 payload produced by #107's readOwnerReport (at 205214f) from
// Uneeza's synthetic test-data/owner-synthetic-p0-v2 full_dataset.jsonl, through the S5-DATA-12
// reconciliation harness, and validated with OwnerDishReportSchema. Synthetic, not captured data.
// Only change from the generated payload: source is 'synthetic' (the harness calls the reader with
// its default, 'production'). Replaced by the live
// GET /api/v1/venues/:venueId/analytics/dishes call in S3-RES-03.
export const UNEEZA_REPORT = {
  schema_version: 'owner_report.v1',
  venue_id: 'e188609f-cebb-44ce-addc-2c583c5229d1',
  source: 'synthetic',
  report_metadata: {
    calculation_version: 'production.v1',
    generated_at: '2026-10-20T07:00:00.000Z',
    date_window: {
      start_time: '2026-10-19T07:00:00.000Z',
      end_time: '2026-10-20T07:00:00.000Z',
      duration_hours: 24,
    },
    coverage: {
      total_dishes_monitored: 3,
      measurable_dishes_count: 3,
    },
    freshness: {
      last_event_ingested_at: '2026-10-20T06:00:07.000Z',
      is_stale: false,
    },
    report_status: 'NORMAL',
  },
  dishes: [
    {
      dish_id: '3ab33c11-791f-4570-b2cf-edf812648043',
      name: 'Bowl',
      evidence_state: 'NORMAL',
      metrics: {
        active_sessions: {
          value: 150,
          status: 'NORMAL',
        },
        avg_interaction_time_seconds: {
          value: null,
          status: 'NOT_MEASURABLE',
        },
        timing_coverage: {
          value: null,
          status: 'NOT_MEASURABLE',
        },
        open_rate: {
          value: 0,
          status: 'VALID_ZERO',
        },
        engagement_rate: {
          value: null,
          status: 'NOT_MEASURABLE',
        },
        save_rate: {
          value: 0,
          status: 'VALID_ZERO',
        },
      },
    },
    {
      dish_id: 'cbb809b1-c92f-4a4b-9932-8faa254e9d8b',
      name: 'Soup',
      evidence_state: 'NORMAL',
      metrics: {
        active_sessions: {
          value: 300,
          status: 'NORMAL',
        },
        avg_interaction_time_seconds: {
          value: 10,
          status: 'NORMAL',
        },
        timing_coverage: {
          value: 1,
          status: 'NORMAL',
        },
        open_rate: {
          value: 0.5,
          status: 'NORMAL',
        },
        engagement_rate: {
          value: 1,
          status: 'NORMAL',
        },
        save_rate: {
          value: 0.5,
          status: 'NORMAL',
        },
      },
    },
    {
      dish_id: 'e8dd497c-8c7c-4f2f-9fe0-fd4122f12769',
      name: 'Salad',
      evidence_state: 'NORMAL',
      metrics: {
        active_sessions: {
          value: 300,
          status: 'NORMAL',
        },
        avg_interaction_time_seconds: {
          value: 5,
          status: 'NORMAL',
        },
        timing_coverage: {
          value: 1,
          status: 'NORMAL',
        },
        open_rate: {
          value: 0.5,
          status: 'NORMAL',
        },
        engagement_rate: {
          value: 0,
          status: 'VALID_ZERO',
        },
        save_rate: {
          value: 1,
          status: 'NORMAL',
        },
      },
    },
  ],
} as const;

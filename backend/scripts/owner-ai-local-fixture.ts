// This fixture is imported only by the local harness and tests, never by the Worker entry.
export const LOCAL_AI_VENUE = '00000000-0000-4000-8000-000000000123';
export const LOCAL_AI_DISH = '00000000-0000-4000-8000-000000000456';
export function localOwnerAiReport(now: Date) {
  return {
    schema_version: 'owner_report.v1',
    venue_id: LOCAL_AI_VENUE,
    source: 'synthetic',
    report_metadata: {
      calculation_version: 'synthetic.owner-ai-local.v1',
      generated_at: now.toISOString(),
      date_window: {
        start_time: new Date(now.getTime() - 86_400_000).toISOString(),
        end_time: now.toISOString(),
        duration_hours: 24,
      },
      coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
      freshness: { is_stale: false, last_event_ingested_at: now.toISOString() },
      report_status: 'NORMAL',
    },
    dishes: [
      {
        dish_id: LOCAL_AI_DISH,
        name: 'Synthetic development dish',
        evidence_state: 'NORMAL',
        metrics: {
          active_sessions: { value: 20, status: 'NORMAL' },
          avg_interaction_time_seconds: { value: 15, status: 'NORMAL' },
          timing_coverage: { value: 1, status: 'NORMAL' },
          open_rate: { value: 0.5, status: 'NORMAL' },
          engagement_rate: { value: 0.3, status: 'NORMAL' },
          save_rate: { value: 0, status: 'VALID_ZERO' },
        },
      },
    ],
  };
}

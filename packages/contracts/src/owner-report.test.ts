import { describe, it, expect } from 'vitest';
import { OwnerDishReportSchema } from './owner-report';

const baseMetadata = {
  calculation_version: 'v1.2.0',
  generated_at: new Date().toISOString(),
  date_window: { start_time: new Date().toISOString(), end_time: new Date().toISOString(), duration_hours: 24 },
  coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
  freshness: { last_event_ingested_at: new Date().toISOString(), is_stale: false },
  report_status: 'NORMAL'
};

const blankMetrics = (status: any, val: any) => ({
  active_sessions: { value: val, status },
  avg_interaction_time_seconds: { value: val, status },
  timing_coverage: { value: val, status },
  open_rate: { value: val, status },
  engagement_rate: { value: val, status },
  save_rate: { value: val, status }
});

describe('OwnerDishReportSchema - Advanced Boundary Assertions', () => {
  it('should parse clean frontier 10 and 11 boundary inputs', () => {
    const payload = {
      schema_version: 'owner_report.v1',
      venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
      source: 'synthetic',
      report_metadata: baseMetadata,
      dishes: [{
        dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
        name: 'Thieb',
        evidence_state: 'NORMAL',
        metrics: blankMetrics('NORMAL', 10)
      }]
    };
    expect(OwnerDishReportSchema.safeParse(payload).success).toBe(true);
  });

  it('should reject non-integer counts', () => {
    const payload = {
      schema_version: 'owner_report.v1',
      venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
      source: 'synthetic',
      report_metadata: baseMetadata,
      dishes: [{
        dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
        name: 'Yassa',
        evidence_state: 'NORMAL',
        metrics: blankMetrics('NORMAL', 12.5) // Fails due to decimal constraint
      }]
    };
    expect(OwnerDishReportSchema.safeParse(payload).success).toBe(false);
  });

  it('should block unknown fields under strict checking constraints', () => {
    const payload = {
      schema_version: 'owner_report.v1',
      venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
      source: 'synthetic',
      unknown_field_test: 'triggered',
      report_metadata: baseMetadata,
      dishes: []
    };
    expect(OwnerDishReportSchema.safeParse(payload).success).toBe(false);
  });

  it('should fail validation if valid_zero status contains a value other than 0', () => {
    const payload = {
      schema_version: 'owner_report.v1',
      venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
      source: 'synthetic',
      report_metadata: baseMetadata,
      dishes: [{
        dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
        name: 'Pastels',
        evidence_state: 'NORMAL',
        metrics: blankMetrics('VALID_ZERO', 5) // Should fail since VALID_ZERO expects exactly 0
      }]
    };
    expect(OwnerDishReportSchema.safeParse(payload).success).toBe(false);
  });
});

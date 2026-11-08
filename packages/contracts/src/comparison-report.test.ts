import { describe, expect, it } from 'vitest';
import { ComparisonReportSchema, ComparisonStatus } from './comparison-report';

const metric: {
  metric_version: string;
  status: string;
  current_value: number | null;
  baseline_value: number | null;
  delta: number | null;
  eligible_sessions: number | null;
} = {
  metric_version: 'rate.v1',
  status: 'COMPARABLE',
  current_value: 0.4,
  baseline_value: 0.3,
  delta: 0.1,
  eligible_sessions: 12,
};

const report = () => ({
  schema_version: 'comparison_report.v1',
  venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
  comparison_eligibility: 'COMPARABLE',
  metrics_metadata: {
    calculation_version: 'v1',
    timezone: 'UTC',
    window_boundaries: {
      current_period: {
        start: '2026-10-26T00:00:00Z',
        end: '2026-11-02T00:00:00Z',
      },
      baseline_period: {
        start: '2026-10-19T00:00:00Z',
        end: '2026-10-26T00:00:00Z',
      },
    },
    exclusions: [],
  },
  dishes: [
    {
      dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
      name: 'Thieb',
      comparison_status: 'COMPARABLE',
      metrics: {
        open_rate: metric,
        engagement_rate: metric,
        save_rate: metric,
      },
    },
  ],
});

describe('ComparisonReportSchema', () => {
  it('accepts a versioned comparison report', () => {
    expect(ComparisonReportSchema.safeParse(report()).success).toBe(true);
  });

  it('accepts a null eligible-session count when cohort size is suppressed', () => {
    const suppressed = report();
    suppressed.dishes[0]!.metrics.open_rate.eligible_sessions = null;
    expect(ComparisonReportSchema.safeParse(suppressed).success).toBe(true);
  });

  it('exports the supported comparison statuses', () => {
    expect(ComparisonStatus.options).toEqual([
      'COMPARABLE',
      'INCOMPATIBLE',
      'INSUFFICIENT',
      'MISSING',
      'VALID_ZERO',
    ]);
  });

  it('rejects unsupported versions, malformed timestamps, and unknown fields', () => {
    const invalidVersion = { ...report(), schema_version: 'comparison_report.v2' };
    expect(ComparisonReportSchema.safeParse(invalidVersion).success).toBe(false);

    const invalidWindow = report();
    invalidWindow.metrics_metadata.window_boundaries.current_period.start = 'not-a-date';
    expect(ComparisonReportSchema.safeParse(invalidWindow).success).toBe(false);

    const withUnknownField = { ...report(), unexpected: true };
    expect(ComparisonReportSchema.safeParse(withUnknownField).success).toBe(false);
  });
});

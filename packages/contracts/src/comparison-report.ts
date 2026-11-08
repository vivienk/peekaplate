import { z } from 'zod';

export const ComparisonStatus = z.enum([
  'COMPARABLE',
  'INCOMPATIBLE',
  'INSUFFICIENT',
  'MISSING',
  'VALID_ZERO',
]);

export type ComparisonStatus = z.infer<typeof ComparisonStatus>;

const period = z.strictObject({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
});

const comparisonMetric = z.strictObject({
  metric_version: z.string().min(1),
  status: ComparisonStatus,
  current_value: z.number().nullable(),
  baseline_value: z.number().nullable(),
  delta: z.number().nullable(),
  eligible_sessions: z.number().int().nonnegative().nullable(),
});

export const ComparisonReportSchema = z.strictObject({
  schema_version: z.literal('comparison_report.v1'),
  venue_id: z.uuid(),
  comparison_eligibility: ComparisonStatus,
  metrics_metadata: z.strictObject({
    calculation_version: z.string().min(1),
    timezone: z.string().min(1),
    window_boundaries: z.strictObject({
      current_period: period,
      baseline_period: period,
    }),
    exclusions: z.array(z.string()),
  }),
  dishes: z.array(
    z.strictObject({
      dish_id: z.uuid(),
      name: z.string().min(1),
      comparison_status: ComparisonStatus,
      metrics: z.strictObject({
        open_rate: comparisonMetric,
        engagement_rate: comparisonMetric,
        save_rate: comparisonMetric,
      }),
    }),
  ),
});

export type ComparisonReport = z.infer<typeof ComparisonReportSchema>;

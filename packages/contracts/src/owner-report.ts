import { z } from 'zod';

const MetricStatusSchema = z.enum([
  'NORMAL',
  'VALID_ZERO',
  'NOT_MEASURABLE',
  'SUPPRESSED',
  'MISSING',
  'STALE',
  'EVIDENCE_CHECK_FAILED'
]);

const MetricValueSchema = z.strictObject({
  value: z.number().int().nonnegative().nullable(),
  status: MetricStatusSchema
}).refine(
  (data) => {
    if (data.status === 'SUPPRESSED' || data.status === 'NOT_MEASURABLE' || data.status === 'MISSING' || data.status === 'STALE' || data.status === 'EVIDENCE_CHECK_FAILED') {
      return data.value === null;
    }
    if (data.status === 'VALID_ZERO') {
      return data.value === 0;
    }
    return data.value !== null;
  },
  { message: 'Value context mismatch based on status validation logic' }
);

const RateValueSchema = z.strictObject({
  value: z.number().min(0).max(1).nullable(),
  status: MetricStatusSchema
}).refine(
  (data) => {
    if (data.status === 'SUPPRESSED' || data.status === 'NOT_MEASURABLE' || data.status === 'MISSING' || data.status === 'STALE' || data.status === 'EVIDENCE_CHECK_FAILED') {
      return data.value === null;
    }
    if (data.status === 'VALID_ZERO') {
      return data.value === 0;
    }
    return data.value !== null;
  },
  { message: 'Rate context mismatch based on status validation logic' }
);

export const OwnerDishReportSchema = z.strictObject({
  schema_version: z.literal('owner_report.v1'),
  venue_id: z.uuid(),
  source: z.enum(['synthetic', 'production']),
  report_metadata: z.strictObject({
    calculation_version: z.string(),
    generated_at: z.iso.datetime(),
    date_window: z.strictObject({
      start_time: z.iso.datetime(),
      end_time: z.iso.datetime(),
      duration_hours: z.number().int().nonnegative()
    }).refine(
      (window) => new Date(window.end_time).getTime() >= new Date(window.start_time).getTime(),
      { message: 'End time cannot be before start time' }
    ),
    coverage: z.strictObject({
      total_dishes_monitored: z.number().int().nonnegative(),
      measurable_dishes_count: z.number().int().nonnegative()
    }).refine(
      (cov) => cov.measurable_dishes_count <= cov.total_dishes_monitored,
      { message: 'Measurable count cannot exceed total monitored dishes' }
    ),
    freshness: z.strictObject({
      last_event_ingested_at: z.iso.datetime().nullable(),
      is_stale: z.boolean()
    }),
    report_status: z.enum(['NORMAL', 'EMPTY', 'STALE', 'ERROR'])
  }).refine(
    (meta) => {
      if (meta.report_status === 'EMPTY') return true;
      return meta.freshness.last_event_ingested_at !== null;
    },
    { message: 'Last event timestamp required unless report is empty' }
  ),
  dishes: z.array(
    z.strictObject({
      dish_id: z.uuid(),
      name: z.string().min(1),
      evidence_state: z.enum(['NORMAL', 'SUPPRESSED', 'NOT_MEASURABLE']),
      metrics: z.strictObject({
        active_sessions: MetricValueSchema,
        avg_interaction_time_seconds: MetricValueSchema,
        timing_coverage: RateValueSchema,
        open_rate: RateValueSchema,
        engagement_rate: RateValueSchema,
        save_rate: RateValueSchema
      })
    })
  ).refine(
    (dishes_list) => dishes_list.every(dish => {
      if (dish.evidence_state === 'SUPPRESSED') {
        return Object.values(dish.metrics).every(m => m.status === 'SUPPRESSED' && m.value === null);
      }
      return true;
    }),
    { message: 'Suppressed dishes cannot have active or normal metric exposures' }
  )
});

export type OwnerDishReport = z.infer<typeof OwnerDishReportSchema>;

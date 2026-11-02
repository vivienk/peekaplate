import { z } from 'zod';

// ADR 0015 (D1): suppress behavioral cells below ten eligible sessions.
export const PRIVACY_FLOOR_SESSIONS = 10;

const MetricStatusSchema = z.enum([
  'NORMAL',
  'VALID_ZERO',
  'NOT_MEASURABLE',
  'SUPPRESSED',
  'MISSING',
  'STALE',
  'EVIDENCE_CHECK_FAILED',
]);

// A metric value shows a number only when its status allows one: NORMAL (any allowed value) or
// VALID_ZERO (exactly 0). Every other status must carry null, so a hidden cell never leaks a value.
const metric = (value: z.ZodNumber) =>
  z
    .strictObject({
      value: value.nullable(),
      status: MetricStatusSchema,
    })
    .refine(
      (data) => {
        if (data.status === 'NORMAL') return data.value !== null;
        if (data.status === 'VALID_ZERO') return data.value === 0;
        return data.value === null;
      },
      { message: 'Value must be null unless status is NORMAL, and exactly 0 for VALID_ZERO' },
    );

// Whole-number counts.
const MetricValueSchema = metric(z.number().int().nonnegative());

// Fractions from 0 to 1.
const RateValueSchema = metric(z.number().min(0).max(1));

// Implementation plan, "Average time interacting": total active time / completed timed openings,
// in seconds with decimals (the plan's example is 25/3 = 8.33). Each opening is capped at five
// minutes, so the average cannot exceed 300. A median is a different metric (ADR 0015) and would
// be its own field once its aggregation rules are pinned.
export const MAX_AVERAGE_ACTIVE_SECONDS = 300;
const AverageSecondsSchema = metric(z.number().min(0).max(MAX_AVERAGE_ACTIVE_SECONDS));

export const OwnerDishReportSchema = z.strictObject({
  schema_version: z.literal('owner_report.v1'),
  venue_id: z.uuid(),
  source: z.enum(['synthetic', 'production']),
  report_metadata: z
    .strictObject({
      calculation_version: z.string(),
      generated_at: z.iso.datetime(),
      date_window: z
        .strictObject({
          start_time: z.iso.datetime(),
          end_time: z.iso.datetime(),
          duration_hours: z.number().int().nonnegative(),
        })
        .refine(
          (window) => new Date(window.end_time).getTime() >= new Date(window.start_time).getTime(),
          { message: 'End time cannot be before start time' },
        ),
      coverage: z
        .strictObject({
          total_dishes_monitored: z.number().int().nonnegative(),
          measurable_dishes_count: z.number().int().nonnegative(),
        })
        .refine((cov) => cov.measurable_dishes_count <= cov.total_dishes_monitored, {
          message: 'Measurable count cannot exceed total monitored dishes',
        }),
      freshness: z.strictObject({
        last_event_ingested_at: z.iso.datetime().nullable(),
        is_stale: z.boolean(),
      }),
      report_status: z.enum(['NORMAL', 'EMPTY', 'STALE', 'ERROR']),
    })
    .refine(
      (meta) => {
        if (meta.report_status === 'EMPTY') return true;
        return meta.freshness.last_event_ingested_at !== null;
      },
      { message: 'Last event timestamp required unless report is empty' },
    ),
  dishes: z
    .array(
      z
        .strictObject({
          dish_id: z.uuid(),
          name: z.string().min(1),
          evidence_state: z.enum(['NORMAL', 'SUPPRESSED', 'NOT_MEASURABLE']),
          metrics: z.strictObject({
            active_sessions: MetricValueSchema,
            avg_interaction_time_seconds: AverageSecondsSchema,
            timing_coverage: RateValueSchema,
            open_rate: RateValueSchema,
            engagement_rate: RateValueSchema,
            save_rate: RateValueSchema,
          }),
        })
        .superRefine((dish, ctx) => {
          // ADR 0015 privacy floor: behavioral values are shown only from ten active sessions.
          const sessions = dish.metrics.active_sessions;
          if (sessions.status === 'NORMAL' && (sessions.value ?? 0) < PRIVACY_FLOOR_SESSIONS) {
            ctx.addIssue({
              code: 'custom',
              path: ['metrics', 'active_sessions', 'value'],
              message: `NORMAL needs at least ${PRIVACY_FLOOR_SESSIONS} active sessions; suppress below that`,
            });
          }
          // Zero sessions is below the floor too, so it is SUPPRESSED (or MISSING when there is no
          // usable data), never VALID_ZERO.
          if (sessions.status === 'VALID_ZERO') {
            ctx.addIssue({
              code: 'custom',
              path: ['metrics', 'active_sessions', 'status'],
              message: 'Zero active sessions is below the privacy floor: use SUPPRESSED or MISSING',
            });
          }
          // Until the floor is shown to be met, nothing may reveal behavior, including the
          // other metrics.
          if (sessions.status !== 'NORMAL') {
            for (const [name, value] of Object.entries(dish.metrics)) {
              if (value.status === 'NORMAL' || value.status === 'VALID_ZERO') {
                ctx.addIssue({
                  code: 'custom',
                  path: ['metrics', name, 'status'],
                  message:
                    'Metrics cannot show values unless active sessions meet the privacy floor',
                });
              }
            }
          }
        }),
    )
    .refine(
      (dishes_list) =>
        dishes_list.every((dish) => {
          if (dish.evidence_state === 'SUPPRESSED') {
            return Object.values(dish.metrics).every(
              (m) => m.status === 'SUPPRESSED' && m.value === null,
            );
          }
          return true;
        }),
      { message: 'Suppressed dishes cannot have active or normal metric exposures' },
    ),
});

export type OwnerDishReport = z.infer<typeof OwnerDishReportSchema>;

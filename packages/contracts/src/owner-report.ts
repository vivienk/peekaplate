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
type MetricValue = { value: number | null; status: z.infer<typeof MetricStatusSchema> };
const valueMatchesStatus = (data: MetricValue) => {
  if (data.status === 'NORMAL') return data.value !== null;
  if (data.status === 'VALID_ZERO') return data.value === 0;
  return data.value === null;
};
const VALUE_MESSAGE = 'Value must be null unless status is NORMAL, and exactly 0 for VALID_ZERO';
const shows = (status: string) => status === 'NORMAL' || status === 'VALID_ZERO';

const metric = (value: z.ZodNumber) =>
  z
    .strictObject({ value: value.nullable(), status: MetricStatusSchema })
    .refine(valueMatchesStatus, { message: VALUE_MESSAGE });

// The report API's internal version of a rate or average: it also carries eligible_sessions, the
// cohort the privacy floor is checked against (Sai, 2 Nov). For a rate, the distinct eligible
// sessions in its denominator; for an average, the distinct sessions that supplied a valid
// measurement. Sessions are counted, never events or openings. These counts never reach owners:
// toOwnerReport() removes them, and the owner schema rejects them.
const cohortMetric = (value: z.ZodNumber) =>
  z
    .strictObject({
      value: value.nullable(),
      status: MetricStatusSchema,
      eligible_sessions: z.number().int().nonnegative(),
    })
    .refine(valueMatchesStatus, { message: VALUE_MESSAGE })
    .superRefine((data, ctx) => {
      if (shows(data.status) && data.eligible_sessions < PRIVACY_FLOOR_SESSIONS) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: `A shown value needs at least ${PRIVACY_FLOOR_SESSIONS} eligible sessions; suppress below that`,
        });
      }
    });

// Whole-number counts.
const count = () => metric(z.number().int().nonnegative());
// Fractions from 0 to 1.
const rateValue = () => z.number().min(0).max(1);

// Implementation plan, "Average time interacting": total active time / completed timed openings,
// in seconds with decimals (the plan's example is 25/3 = 8.33). Each opening is capped at five
// minutes, so the average cannot exceed 300. A median is a different metric (ADR 0015) and would
// be its own field once its aggregation rules are pinned.
export const MAX_AVERAGE_ACTIVE_SECONDS = 300;
const averageValue = () => z.number().min(0).max(MAX_AVERAGE_ACTIVE_SECONDS);

// The rates and the average: the metrics whose own cohort is checked against the floor.
export const COHORT_METRICS = [
  'avg_interaction_time_seconds',
  'timing_coverage',
  'open_rate',
  'engagement_rate',
  'save_rate',
] as const;

const COMPLEMENTARY_SUPPRESSION_METRICS = [
  'avg_interaction_time_seconds',
  'timing_coverage',
  'open_rate',
] as const;

function reportSchema<Rate extends z.ZodType<MetricValue>, Average extends z.ZodType<MetricValue>>(
  rate: () => Rate,
  average: () => Average,
  checkCohorts: boolean,
) {
  return z.strictObject({
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
            (window) =>
              new Date(window.end_time).getTime() >= new Date(window.start_time).getTime(),
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
          // Null means pipeline evidence is insufficient to verify freshness.
          is_stale: z.boolean().nullable(),
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
              active_sessions: count(),
              avg_interaction_time_seconds: average(),
              timing_coverage: rate(),
              open_rate: rate(),
              engagement_rate: rate(),
              save_rate: rate(),
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
            // Zero sessions is below the floor too, so it is SUPPRESSED (or MISSING when there is
            // no usable data), never VALID_ZERO.
            if (sessions.status === 'VALID_ZERO') {
              ctx.addIssue({
                code: 'custom',
                path: ['metrics', 'active_sessions', 'status'],
                message:
                  'Zero active sessions is below the privacy floor: use SUPPRESSED or MISSING',
              });
            }
            // Until the floor is shown to be met, nothing may reveal behavior, including the
            // other metrics.
            const complementarySuppression =
              !checkCohorts &&
              sessions.status === 'SUPPRESSED' &&
              dish.evidence_state === 'NORMAL' &&
              COMPLEMENTARY_SUPPRESSION_METRICS.every((name) =>
                Object.entries(dish.metrics).some(
                  ([metricName, metric]) => metricName === name && metric.status === 'SUPPRESSED',
                ),
              );
            // The serializer may hide these cells while retaining independently safe cohorts.
            if (sessions.status !== 'NORMAL' && !complementarySuppression) {
              for (const [name, value] of Object.entries(dish.metrics)) {
                if (shows(value.status)) {
                  ctx.addIssue({
                    code: 'custom',
                    path: ['metrics', name, 'status'],
                    message:
                      'Metrics cannot show values unless active sessions meet the privacy floor',
                  });
                }
              }
            }
            // A zero denominator (no eligible sessions) is NOT_MEASURABLE, never 0% and never a
            // suppressed value (implementation plan; ADR 0015). On a dish below the floor every
            // metric stays SUPPRESSED instead, since "not measurable" would itself reveal the zero.
            if (checkCohorts && sessions.status === 'NORMAL') {
              for (const name of COHORT_METRICS) {
                const cells = dish.metrics as Record<
                  string,
                  MetricValue & { eligible_sessions?: number }
                >;
                const cell = cells[name];
                if (!cell) continue;
                if (
                  cell.eligible_sessions === 0 &&
                  (shows(cell.status) || cell.status === 'SUPPRESSED')
                ) {
                  ctx.addIssue({
                    code: 'custom',
                    path: ['metrics', name, 'status'],
                    message: 'No eligible sessions: a zero denominator is NOT_MEASURABLE',
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
}

// What owners receive. It carries no cohort counts: a payload containing eligible_sessions is
// rejected as an unknown field.
export const OwnerDishReportSchema = reportSchema(
  () => metric(rateValue()),
  () => metric(averageValue()),
  false,
);

// What the report API builds first. Every rate and average carries its eligible_sessions, and is
// shown only when that cohort reaches the floor. Passing this check does not make a cell safe on
// its own: the API must still suppress cells whose rate, counts or related cells would reveal a
// protected small group (complementary suppression, implementation plan; agreed with Sai).
export const InternalOwnerDishReportSchema = reportSchema(
  () => cohortMetric(rateValue()),
  () => cohortMetric(averageValue()),
  true,
);

export type OwnerDishReport = z.infer<typeof OwnerDishReportSchema>;
export type InternalOwnerDishReport = z.infer<typeof InternalOwnerDishReportSchema>;

// Checks the internal report, removes every eligible_sessions and checks the owner payload, so
// cohort counts can never be sent to an owner.
export function toOwnerReport(internal: unknown): OwnerDishReport {
  const report = InternalOwnerDishReportSchema.parse(internal);
  return OwnerDishReportSchema.parse({
    ...report,
    dishes: report.dishes.map((dish) => {
      const hideTimingRelatedMetrics =
        dish.metrics.avg_interaction_time_seconds.eligible_sessions > 0 &&
        dish.metrics.avg_interaction_time_seconds.eligible_sessions < PRIVACY_FLOOR_SESSIONS;
      const hideSmallOpenedCohort =
        dish.metrics.engagement_rate.eligible_sessions > 0 &&
        dish.metrics.engagement_rate.eligible_sessions < PRIVACY_FLOOR_SESSIONS;
      const timingRelatedMetrics = new Set([
        'active_sessions',
        'avg_interaction_time_seconds',
        'timing_coverage',
        'open_rate',
      ]);

      return {
        ...dish,
        metrics: Object.fromEntries(
          Object.entries(dish.metrics).map(([name, { value, status }]) => [
            name,
            (hideTimingRelatedMetrics || hideSmallOpenedCohort) && timingRelatedMetrics.has(name)
              ? { value: null, status: 'SUPPRESSED' }
              : { value, status },
          ]),
        ),
      };
    }),
  });
}

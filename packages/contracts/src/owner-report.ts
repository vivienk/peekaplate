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

const summaryWindow = z.strictObject({ start_time: z.iso.datetime(), end_time: z.iso.datetime() });
const unavailableSummaryMetric = z.strictObject({ value: z.null(), status: z.literal('MISSING') });
const summaryCount = (allowSmallCounts: boolean) =>
  count().refine(
    (cell) =>
      allowSmallCounts ||
      !shows(cell.status) ||
      (cell.value !== null && cell.value >= PRIVACY_FLOOR_SESSIONS),
    { message: 'A visible summary count must meet the ten-session floor' },
  );
const summaryMetrics = (allowSmallCounts: boolean) =>
  z.strictObject({
    menu_sessions: summaryCount(allowSmallCounts),
    dish_opens: summaryCount(allowSmallCounts),
    avg_interaction_time_seconds: metric(averageValue()),
    portion_previews_shown: allowSmallCounts ? summaryCount(false) : unavailableSummaryMetric,
    verified_orders: unavailableSummaryMetric,
  });
function summarySchema(allowSmallCounts: boolean) {
  return z
    .strictObject({
      periods: z.strictObject({ current: summaryWindow, baseline: summaryWindow }),
      current: summaryMetrics(allowSmallCounts),
      baseline: summaryMetrics(allowSmallCounts),
      daily_opens: z
        .strictObject({
          current: z
            .array(summaryWindow.extend({ opens: summaryCount(allowSmallCounts) }))
            .min(1)
            .max(2),
          baseline: z
            .array(summaryWindow.extend({ opens: summaryCount(allowSmallCounts) }))
            .min(1)
            .max(2),
        })
        .optional(),
    })
    .superRefine((summary, ctx) => {
      if (!summary.daily_opens) return;
      for (const period of ['current', 'baseline'] as const) {
        const buckets = summary.daily_opens[period];
        let cursor = Date.parse(summary.periods[period].start_time);
        const end = Date.parse(summary.periods[period].end_time);
        for (const bucket of buckets) {
          const nextMidnight = Math.floor(cursor / 86400000) * 86400000 + 86400000;
          if (
            Date.parse(bucket.start_time) !== cursor ||
            Date.parse(bucket.end_time) !== Math.min(nextMidnight, end) ||
            cursor >= end
          )
            ctx.addIssue({
              code: 'custom',
              path: ['daily_opens', period],
              message: 'Daily buckets must cover clipped UTC days in the report period',
            });
          cursor = Date.parse(bucket.end_time);
        }
        if (cursor !== end)
          ctx.addIssue({
            code: 'custom',
            path: ['daily_opens', period],
            message: 'Daily buckets must cover the whole period',
          });
        if (
          buckets.some((bucket) => bucket.opens.status === 'SUPPRESSED') &&
          (buckets.some((bucket) => bucket.opens.value !== null) ||
            Object.values(summary[period]).some((cell) => cell.value !== null))
        )
          ctx.addIssue({
            code: 'custom',
            path: ['daily_opens', period],
            message:
              'Protected daily buckets require complementary suppression of the series and totals',
          });
      }
    });
}
export const OwnerReportSummarySchema = summarySchema(false);
export const ProductionBatchSummarySchema = summarySchema(true);
export const OWNER_PRODUCTION_BATCH_VERSION = 'production.batch.v1';
export const OWNER_PRODUCTION_DAY_VERSION = 'production.sf-day.v1';
export const OWNER_REPORT_TIME_ZONE = 'America/Los_Angeles';

const dayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: OWNER_REPORT_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  hourCycle: 'h23',
});

export function ownerReportMidnight(time: Date, dayOffset = 0): Date {
  const parts = Object.fromEntries(
    dayFormat.formatToParts(time).map((part) => [part.type, part.value]),
  );
  // 08:00 UTC is midnight or 01:00 Pacific, before either DST transition.
  const candidate = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset, 8),
  );
  const localHour = Number(
    dayFormat.formatToParts(candidate).find((part) => part.type === 'hour')?.value,
  );
  return new Date(candidate.getTime() - localHour * 3_600_000);
}
export type OwnerReportSummary = z.infer<typeof OwnerReportSummarySchema>;

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
  return z
    .strictObject({
      schema_version: z.literal('owner_report.v1'),
      venue_id: z.uuid(),
      source: z.enum(['synthetic', 'production']),
      summary: ProductionBatchSummarySchema.optional(),
      report_metadata: z.strictObject({
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
      }),
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
              display_actions: z
                .strictObject({
                  portion_previews_shown: summaryCount(false).optional(),
                  comparisons_started: summaryCount(false).optional(),
                })
                .optional(),
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
    })
    .superRefine((report, ctx) => {
      const metadata = report.report_metadata;
      const day =
        report.source === 'production' &&
        metadata.calculation_version === OWNER_PRODUCTION_DAY_VERSION;
      const batch =
        day ||
        (report.source === 'production' &&
          metadata.calculation_version === OWNER_PRODUCTION_BATCH_VERSION);
      if (
        report.dishes.some(
          ({ display_actions, evidence_state }) =>
            display_actions !== undefined && (!batch || evidence_state !== 'NORMAL'),
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['dishes'],
          message:
            'Display-action counts require a reportable dish in a completed production batch',
        });
      }
      if (
        metadata.report_status !== 'EMPTY' &&
        metadata.freshness.last_event_ingested_at === null &&
        (report.source !== 'production' || metadata.freshness.is_stale !== null)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['report_metadata', 'freshness', 'last_event_ingested_at'],
          message: 'A nonempty report requires an ingestion timestamp when freshness is known',
        });
      }
      const summary = report.summary;
      if (!summary) {
        if (day)
          ctx.addIssue({
            code: 'custom',
            path: ['summary'],
            message: 'San Francisco day reports require a summary',
          });
        return;
      }
      if (!batch && !OwnerReportSummarySchema.safeParse(summary).success)
        ctx.addIssue({
          code: 'custom',
          path: ['summary'],
          message: 'Only the completed production batch can expose sub-ten restaurant totals',
        });
      const at = Date.parse;
      const current = summary.periods.current;
      const baseline = summary.periods.baseline;
      const window = report.report_metadata.date_window;
      const start = at(current.start_time);
      const end = at(current.end_time);
      const validInterval = day
        ? Number.isFinite(start) &&
          Number.isFinite(end) &&
          start === ownerReportMidnight(new Date(start)).getTime() &&
          end >= start &&
          end <= ownerReportMidnight(new Date(start), 1).getTime() &&
          at(baseline.start_time) === ownerReportMidnight(new Date(start), -1).getTime() &&
          at(metadata.generated_at) === end &&
          summary.current.avg_interaction_time_seconds.status === 'MISSING' &&
          summary.current.portion_previews_shown.status === 'MISSING' &&
          !summary.daily_opens
        : end > start && end - start === at(baseline.end_time) - at(baseline.start_time);
      const dishPeriod = day ? baseline : current;
      if (
        at(dishPeriod.start_time) !== at(window.start_time) ||
        at(dishPeriod.end_time) !== at(window.end_time) ||
        at(baseline.end_time) !== start ||
        !validInterval
      )
        ctx.addIssue({
          code: 'custom',
          path: ['summary', 'periods'],
          message: 'Summary periods must match the report and its required adjacent baseline',
        });
      if (
        ['STALE', 'ERROR'].includes(report.report_metadata.report_status) &&
        [
          ...Object.values(summary.current),
          ...Object.values(summary.baseline),
          ...(summary.daily_opens
            ? [...summary.daily_opens.current, ...summary.daily_opens.baseline].map(
                (bucket) => bucket.opens,
              )
            : []),
        ].some((cell) => cell.value !== null)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['summary'],
          message: 'Unusable report cannot expose summary values',
        });
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

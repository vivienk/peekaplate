import { z } from 'zod';

export const OwnerAnalysisRequestSchema = z.strictObject({
  dishId: z.uuid(),
  goal: z.enum(['menu', 'engagement', 'crm']),
});
export const OwnerAnalysisMetricSchema = z.enum(['open_rate', 'engagement_rate', 'save_rate']);
export const OwnerAnalysisResultSchema = z
  .strictObject({
    schemaVersion: z.literal('owner-analysis.v1'),
    venueId: z.uuid(),
    dishId: z.uuid(),
    goal: OwnerAnalysisRequestSchema.shape.goal,
    source: z.enum(['synthetic', 'production']),
    reportSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
    timeWindow: z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() }),
    status: z.enum(['review', 'abstained']),
    metric: OwnerAnalysisMetricSchema.nullable(),
    value: z.number().min(0).max(1).nullable(),
    reason: z.enum(['review_evidence', 'unusable_evidence', 'unsupported_goal', 'model_abstained']),
    approvalRequired: z.literal(true),
    allowedEffects: z.tuple([]),
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.timeWindow.start) >= Date.parse(value.timeWindow.end)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid time window' });
    }
    if (
      value.status === 'review'
        ? value.metric === null || value.value === null || value.reason !== 'review_evidence'
        : value.metric !== null || value.value !== null || value.reason === 'review_evidence'
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid analysis disposition' });
    }
  });
export type OwnerAnalysisRequest = z.infer<typeof OwnerAnalysisRequestSchema>;
export type OwnerAnalysisResult = z.infer<typeof OwnerAnalysisResultSchema>;

export const OWNER_REPORT_QUESTION_MAX_LENGTH = 400;

export const OwnerReportQuestionRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(OWNER_REPORT_QUESTION_MAX_LENGTH),
});

const questionWindow = z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() });

const questionReportScope = {
  schemaVersion: z.literal('owner-report-question.v1'),
  venueId: z.uuid(),
  source: z.enum(['synthetic', 'production']),
  reportSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
  timeWindow: questionWindow,
  overview: z
    .discriminatedUnion('period', [
      z.strictObject({ period: z.literal('current') }),
      z.strictObject({ period: z.literal('baseline') }),
      z.strictObject({ period: z.literal('compare'), baselineWindow: questionWindow }),
    ])
    .optional(),
};

export const OwnerReportQuestionResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...questionReportScope,
      status: z.literal('answered'),
      metric: z.enum([
        'active_sessions',
        'open_rate',
        'avg_interaction_time_seconds',
        'timing_coverage',
        'save_rate',
        'engagement_rate',
        'portion_previews_shown',
        'comparisons_started',
        'dish_opens',
        'menu_sessions',
      ]),
      points: z
        .array(
          z.strictObject({ label: z.string().min(1).max(160), value: z.number().nonnegative() }),
        )
        .min(1)
        .max(20),
      chart: z.boolean(),
    }),
    z.strictObject({
      ...questionReportScope,
      status: z.literal('abstained'),
      reason: z.enum(['unsupported_question', 'unusable_evidence']),
    }),
  ])
  .superRefine((result, context) => {
    const start = Date.parse(result.timeWindow.start);
    const end = Date.parse(result.timeWindow.end);
    if (start > end || (result.status === 'answered' && start === end)) {
      context.addIssue({ code: 'custom', path: ['timeWindow'], message: 'Invalid time window' });
    }
    if (result.overview?.period === 'compare') {
      const baseline = result.overview.baselineWindow;
      const baselineStart = Date.parse(baseline.start);
      const baselineEnd = Date.parse(baseline.end);
      if (
        baselineStart > baselineEnd ||
        (result.status === 'answered' && baselineStart === baselineEnd)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['overview', 'baselineWindow'],
          message: 'Invalid baseline time window',
        });
      }
    }
    if (result.status === 'answered') {
      const overviewMetric = result.metric === 'dish_opens' || result.metric === 'menu_sessions';
      if (
        overviewMetric !== Boolean(result.overview) ||
        (result.overview && result.points.length !== (result.overview.period === 'compare' ? 2 : 1))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['overview'],
          message: 'Invalid Overview answer scope',
        });
      }
      const validValues = result.points.every(({ value }) => {
        switch (result.metric) {
          case 'active_sessions':
          case 'portion_previews_shown':
          case 'comparisons_started':
          case 'dish_opens':
          case 'menu_sessions':
            return Number.isSafeInteger(value);
          case 'avg_interaction_time_seconds':
            return value <= 300;
          default:
            return value <= 1;
        }
      });
      if (!validValues) {
        context.addIssue({ code: 'custom', path: ['points'], message: 'Invalid metric value' });
      }
    }
  });

export type OwnerReportQuestionRequest = z.infer<typeof OwnerReportQuestionRequestSchema>;
export type OwnerReportQuestionResult = z.infer<typeof OwnerReportQuestionResultSchema>;

// Model output never supplies owner-visible prose or executable actions.
export const OWNER_ANALYSIS_ACTIONS = {
  open_rate: 'Review the approved dish card and whether it clearly represents the dish.',
  engagement_rate: 'Review the approved dish details for clarity and completeness.',
  save_rate: 'Review whether the Save control is clear and useful to diners.',
} as const;
export const OWNER_ANALYSIS_LIMITATION =
  'Browsing activity does not establish purchases, customer retention, revenue, or the effect of a menu change. Review this suggestion before making changes.';

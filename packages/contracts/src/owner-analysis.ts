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
    source: z.literal('synthetic'),
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

// Model output never supplies owner-visible prose or executable actions.
export const OWNER_ANALYSIS_ACTIONS = {
  open_rate: 'Review the approved dish card and whether it clearly represents the dish.',
  engagement_rate: 'Review the approved dish details for clarity and completeness.',
  save_rate: 'Review whether the Save control is clear and useful to diners.',
} as const;
export const OWNER_ANALYSIS_LIMITATION =
  'Browsing activity does not establish purchases, customer retention, revenue, or the effect of a menu change. Review this suggestion before making changes.';

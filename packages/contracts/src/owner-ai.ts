import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const boundedText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\u0000'), 'NUL is not supported');

export const MAX_OWNER_AI_EVIDENCE = 12;
export const MAX_OWNER_AI_CONTEXT_CHARS = 8_000;

export const OwnerAiMetricKeySchema = z.enum(['open_rate', 'engagement_rate', 'save_rate']);

export const OwnerAiTimeWindowSchema = z
  .strictObject({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .refine((window) => Date.parse(window.start) < Date.parse(window.end), {
    path: ['end'],
    message: 'Time window end must be after start',
  });

const ownerEvidenceIdentity = {
  evidenceId: uuid,
  venueId: uuid,
  reportId: uuid,
  reportVersion: z.number().int().positive().max(2_147_483_647),
  metricKey: OwnerAiMetricKeySchema,
  timeWindow: OwnerAiTimeWindowSchema,
};

export const AvailableOwnerAiEvidenceSchema = z.strictObject({
  ...ownerEvidenceIdentity,
  state: z.literal('available'),
  value: z.number().min(0).max(1),
  eligibleSessions: z.number().int().min(10).max(Number.MAX_SAFE_INTEGER),
  untrustedSummary: boundedText(500).optional(),
});

export const WithheldOwnerAiEvidenceSchema = z.strictObject({
  ...ownerEvidenceIdentity,
  state: z.enum(['missing', 'suppressed', 'stale', 'conflicting', 'unsupported']),
});

export const OwnerAiEvidenceSchema = z.discriminatedUnion('state', [
  AvailableOwnerAiEvidenceSchema,
  WithheldOwnerAiEvidenceSchema,
]);

export const OwnerRecommendationRequestSchema = z
  .strictObject({
    schemaVersion: z.literal('owner-recommendation.v1'),
    requestId: uuid,
    venueId: uuid,
    reportId: uuid,
    reportVersion: z.number().int().positive().max(2_147_483_647),
    timeWindow: OwnerAiTimeWindowSchema,
    question: boundedText(500).optional(),
    evidence: z.array(OwnerAiEvidenceSchema).max(MAX_OWNER_AI_EVIDENCE),
  })
  .superRefine((request, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < request.evidence.length; index++) {
      const item = request.evidence[index];
      if (!item) continue;
      if (seen.has(item.evidenceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', index, 'evidenceId'],
          message: 'Evidence IDs must be unique',
        });
      }
      seen.add(item.evidenceId);
    }
  });

const ownerRecommendationBase = {
  schemaVersion: z.literal('owner-recommendation.v1'),
  requestId: uuid,
  reportId: uuid,
  reportVersion: z.number().int().positive().max(2_147_483_647),
  timeWindow: OwnerAiTimeWindowSchema,
  generatorVersion: boundedText(64),
  approvalRequired: z.literal(true),
  allowedEffects: z.tuple([]),
};

export const OwnerRecommendationSchema = z.strictObject({
  ...ownerRecommendationBase,
  status: z.literal('recommendation'),
  draftAction: boundedText(500),
  rationale: boundedText(1_000),
  evidenceRefs: z.array(uuid).min(1).max(3),
  limitations: z.array(boundedText(300)).min(1).max(5),
  confidence: z.enum(['low', 'medium', 'high']),
});

export const OwnerRecommendationAbstentionSchema = z.strictObject({
  ...ownerRecommendationBase,
  status: z.literal('abstained'),
  reason: z.enum([
    'missing_evidence',
    'suppressed_evidence',
    'stale_evidence',
    'conflicting_evidence',
    'unsupported_evidence',
    'insufficient_evidence',
  ]),
  message: boundedText(500),
  evidenceRefs: z.array(uuid).max(MAX_OWNER_AI_EVIDENCE),
});

export const OwnerRecommendationResultSchema = z.discriminatedUnion('status', [
  OwnerRecommendationSchema,
  OwnerRecommendationAbstentionSchema,
]);

export type OwnerAiMetricKey = z.infer<typeof OwnerAiMetricKeySchema>;
export type OwnerAiEvidence = z.infer<typeof OwnerAiEvidenceSchema>;
export type OwnerRecommendationRequest = z.infer<typeof OwnerRecommendationRequestSchema>;
export type OwnerRecommendationResult = z.infer<typeof OwnerRecommendationResultSchema>;

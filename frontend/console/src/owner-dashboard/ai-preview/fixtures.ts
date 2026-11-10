import { OwnerRecommendationResultSchema } from '@peekaplate/contracts/owner-ai';

// Public, value-free-of-cohort result examples. These are handwritten synthetic
// wire payloads, not output from a live report, model or approved production policy.
const identity = {
  schemaVersion: 'owner-recommendation.v1',
  requestId: '00000000-0000-4000-8000-000000000401',
  venueId: '00000000-0000-4000-8000-000000000402',
  reportId: '00000000-0000-4000-8000-000000000403',
  reportVersion: 1,
  timeWindow: { start: '2026-10-05T00:00:00Z', end: '2026-10-12T00:00:00Z' },
  generatorVersion: 'synthetic-preview.v1',
  policyVersion: 'synthetic-preview.v1',
  approvalRequired: true,
  allowedEffects: [],
};

export const syntheticPreviewContext = {
  venueId: identity.venueId,
  timeWindow: identity.timeWindow,
  reportId: identity.reportId,
};

export const syntheticRecommendation = OwnerRecommendationResultSchema.parse({
  ...identity,
  status: 'recommendation',
  ruleId: 'synthetic.open-rate',
  actionId: 'review_dish_card',
  draftAction: 'Review the dish card wording and approved photo before proposing a change.',
  rationale: 'This fictional example illustrates an evidence-linked, review-only draft action.',
  evidenceRefs: ['00000000-0000-4000-8000-000000000404'],
  limitations: [
    'Synthetic demonstration only; this is not advice for a real restaurant.',
    'Observed menu activity does not establish diner motives, orders or revenue.',
  ],
  confidence: 'low',
});

export const syntheticAbstention = OwnerRecommendationResultSchema.parse({
  ...identity,
  requestId: '00000000-0000-4000-8000-000000000405',
  status: 'abstained',
  reason: 'missing_evidence',
  message: 'No supported recommendation is available for this synthetic example.',
  evidenceRefs: [],
});

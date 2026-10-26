import { describe, expect, it } from 'vitest';
import {
  MAX_OWNER_AI_EVIDENCE,
  OwnerRecommendationRequestSchema,
  OwnerRecommendationResultSchema,
} from './owner-ai';

const venueId = '00000000-0000-4000-8000-000000000001';
const reportId = '00000000-0000-4000-8000-000000000002';
const timeWindow = {
  start: '2026-10-01T00:00:00.000Z',
  end: '2026-10-08T00:00:00.000Z',
};
const evidence = {
  evidenceId: '00000000-0000-4000-8000-000000000003',
  venueId,
  reportId,
  reportVersion: 1,
  metricKey: 'open_rate',
  timeWindow,
  state: 'available',
  value: 0.2,
  eligibleSessions: 20,
};
const request = {
  schemaVersion: 'owner-recommendation.v1',
  requestId: '00000000-0000-4000-8000-000000000004',
  venueId,
  reportId,
  reportVersion: 1,
  timeWindow,
  evidence: [evidence],
};

describe('owner recommendation contracts', () => {
  it('accepts bounded validated evidence', () => {
    expect(OwnerRecommendationRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects privacy-threshold leaks, injected authority, duplicates and oversized context', () => {
    expect(
      OwnerRecommendationRequestSchema.safeParse({
        ...request,
        evidence: [{ ...evidence, eligibleSessions: 9 }],
      }).success,
    ).toBe(false);
    expect(
      OwnerRecommendationRequestSchema.safeParse({ ...request, actorId: venueId }).success,
    ).toBe(false);
    expect(
      OwnerRecommendationRequestSchema.safeParse({ ...request, evidence: [evidence, evidence] })
        .success,
    ).toBe(false);
    expect(
      OwnerRecommendationRequestSchema.safeParse({
        ...request,
        evidence: Array.from({ length: MAX_OWNER_AI_EVIDENCE + 1 }, (_, index) => ({
          ...evidence,
          evidenceId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        })),
      }).success,
    ).toBe(false);
  });

  it('keeps withheld evidence free of hidden values and executable effects', () => {
    expect(
      OwnerRecommendationRequestSchema.safeParse({
        ...request,
        evidence: [{ ...evidence, state: 'suppressed', value: 0.2, eligibleSessions: 9 }],
      }).success,
    ).toBe(false);
    expect(
      OwnerRecommendationResultSchema.safeParse({
        schemaVersion: 'owner-recommendation.v1',
        requestId: request.requestId,
        reportId,
        reportVersion: 1,
        timeWindow,
        generatorVersion: 'test.v1',
        approvalRequired: true,
        allowedEffects: ['publish_menu'],
        status: 'abstained',
        reason: 'suppressed_evidence',
        message: 'Evidence is suppressed.',
        evidenceRefs: [evidence.evidenceId],
      }).success,
    ).toBe(false);
  });
});

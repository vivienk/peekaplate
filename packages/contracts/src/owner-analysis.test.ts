import { describe, expect, it } from 'vitest';
import { OwnerAnalysisRequestSchema, OwnerAnalysisResultSchema } from './owner-analysis';

const dishId = '00000000-0000-4000-8000-000000000456';
const request = { dishId, goal: 'menu' };
const fact = {
  ...request,
  schemaVersion: 'owner-analysis.v1',
  venueId: '00000000-0000-4000-8000-000000000123',
  source: 'synthetic',
  reportSnapshot: 'a'.repeat(64),
  timeWindow: { start: '2026-11-16T00:00:00Z', end: '2026-11-17T00:00:00Z' },
  status: 'answered',
  answer: 'The measured save rate was 0%.',
  reason: 'report_fact',
  metric: null,
  value: null,
  approvalRequired: true,
  allowedEffects: [],
};

describe('owner report questions', () => {
  it('accepts legacy requests and bounded questions but rejects supplied report data', () => {
    expect(OwnerAnalysisRequestSchema.safeParse(request).success).toBe(true);
    expect(OwnerAnalysisRequestSchema.parse({ ...request, question: '  Why?  ' }).question).toBe(
      'Why?',
    );
    expect(
      OwnerAnalysisRequestSchema.safeParse({ ...request, question: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(OwnerAnalysisRequestSchema.safeParse({ ...request, metrics: {} }).success).toBe(false);
  });

  it('requires an answer for facts and excludes one from abstentions', () => {
    expect(OwnerAnalysisResultSchema.safeParse(fact).success).toBe(true);
    expect(OwnerAnalysisResultSchema.safeParse({ ...fact, answer: undefined }).success).toBe(false);
    expect(
      OwnerAnalysisResultSchema.safeParse({
        ...fact,
        status: 'abstained',
        reason: 'unusable_evidence',
      }).success,
    ).toBe(false);
  });
});

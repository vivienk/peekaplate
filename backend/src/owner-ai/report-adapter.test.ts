import { toOwnerReport } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { toOwnerRecommendationRequest } from './index';
import {
  buildOwnerRecommendation,
  OwnerAiAuthorizationError,
  validateOwnerRecommendationResult,
} from './recommendation';

const venueId = '00000000-0000-4000-8000-000000000001';
const dishId = '00000000-0000-4000-8000-000000000002';
const otherDishId = '00000000-0000-4000-8000-000000000003';
const uuid = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const cell = (value: number | null, status = 'NORMAL', eligible_sessions = 12) => ({
  value,
  status,
  eligible_sessions,
});
const report = () => ({
  schema_version: 'owner_report.v1',
  venue_id: venueId,
  source: 'synthetic',
  report_metadata: {
    calculation_version: 'adapter.synthetic.v1',
    generated_at: '2026-11-03T12:00:00Z',
    date_window: {
      start_time: '2026-11-02T00:00:00Z',
      end_time: '2026-11-03T00:00:00Z',
      duration_hours: 24,
    },
    coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
    freshness: {
      last_event_ingested_at: '2026-11-03T11:00:00Z',
      is_stale: false as boolean | null,
    },
    report_status: 'NORMAL',
  },
  dishes: [
    {
      dish_id: dishId,
      name: 'Synthetic adapter dish',
      evidence_state: 'NORMAL',
      metrics: {
        active_sessions: { value: 20, status: 'NORMAL' },
        avg_interaction_time_seconds: cell(30),
        timing_coverage: cell(1),
        open_rate: cell(0.6, 'NORMAL', 20),
        engagement_rate: cell(0.2),
        save_rate: cell(0, 'VALID_ZERO'),
      },
    },
  ],
});

// Synthetic server-issued context, not browser authority or a producer identity derivation.
const snapshot = () => ({
  requestId: uuid(10),
  reportId: uuid(11),
  reportVersion: 1,
  venueId,
  dishId,
  source: 'synthetic',
  calculationVersion: 'adapter.synthetic.v1',
  generatedAt: '2026-11-03T12:00:00Z',
  timeWindow: { start: '2026-11-02T00:00:00Z', end: '2026-11-03T00:00:00Z' },
  evidenceIds: { open_rate: uuid(12), engagement_rate: uuid(13), save_rate: uuid(14) },
});
const scope = () => ({ authorizedVenueId: venueId, dishId, snapshot: snapshot() });
const policy = {
  schemaVersion: 'owner-recommendation-policy.v1',
  policyVersion: 'adapter.synthetic.v1',
  rules: [
    {
      ruleId: 'save.synthetic.v1',
      priority: 1,
      metricKey: 'save_rate',
      maximumInclusive: 0,
      actionId: 'review_save_affordance',
      confidence: 'low',
    },
  ],
};
const recommend = (input: unknown, context = scope()) => {
  const request = toOwnerRecommendationRequest(input, context);
  return {
    request,
    result: buildOwnerRecommendation(request, { authorizedVenueId: venueId, policy }),
  };
};

describe('AI-01 report-to-core consumer adapter', () => {
  it('connects a genuine zero to the unchanged core, trusted references and count-free result', () => {
    const input = report();
    const before = structuredClone(input);
    const { request, result } = recommend(input);
    expect(request.evidence[2]).toMatchObject({
      evidenceId: uuid(14),
      state: 'available',
      value: 0,
      eligibleSessions: 12,
      timeWindow: snapshot().timeWindow,
    });
    expect(result).toMatchObject({
      status: 'recommendation',
      reportId: uuid(11),
      reportVersion: 1,
      evidenceRefs: [uuid(14)],
      rationale: 'save_rate was 0.0% for the selected report window.',
      generatorVersion: 'deterministic-rules.v1',
      approvalRequired: true,
      allowedEffects: [],
    });
    expect(validateOwnerRecommendationResult(result, request, policy)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(
      /eligibleSessions|eligible_sessions|Synthetic adapter/,
    );
    expect(input).toEqual(before);
  });

  it('maps a zero denominator to missing evidence and abstention, never a zero rate', () => {
    const input = report();
    input.dishes[0]!.metrics.save_rate = cell(null, 'NOT_MEASURABLE', 0);
    const { request, result } = recommend(input);
    expect(request.evidence[2]).toEqual({
      evidenceId: uuid(14),
      venueId,
      reportId: uuid(11),
      reportVersion: 1,
      metricKey: 'save_rate',
      timeWindow: snapshot().timeWindow,
      state: 'missing',
    });
    expect(result).toMatchObject({ status: 'abstained', reason: 'missing_evidence' });
  });

  it('withholds all evidence when freshness is unknown despite an otherwise valid zero', () => {
    const input = report();
    input.report_metadata.freshness.is_stale = null;
    const { request, result } = recommend(input);
    expect(request.evidence.map((item) => item.state)).toEqual(['missing', 'missing', 'missing']);
    for (const item of request.evidence) {
      expect(item).not.toHaveProperty('value');
      expect(item).not.toHaveProperty('eligibleSessions');
    }
    expect(result).toMatchObject({ status: 'abstained', reason: 'missing_evidence' });
  });

  it.each([
    ['SUPPRESSED', 'suppressed', 9],
    ['STALE', 'stale', 12],
    ['EVIDENCE_CHECK_FAILED', 'conflicting', 12],
  ])('preserves %s evidence as a value-free core state', (status, state, count) => {
    const input = report();
    input.dishes[0]!.metrics.save_rate = cell(null, String(status), Number(count));
    const { request, result } = recommend(input);
    expect(request.evidence[2]).toMatchObject({ state });
    expect(request.evidence[2]).not.toHaveProperty('value');
    expect(request.evidence[2]).not.toHaveProperty('eligibleSessions');
    expect(result.status).toBe('abstained');
  });

  it('retains complementary suppression applied by the shared owner serializer', () => {
    const input = report();
    input.dishes[0]!.metrics.avg_interaction_time_seconds = cell(null, 'SUPPRESSED', 9);
    input.dishes[0]!.metrics.timing_coverage = cell(null, 'SUPPRESSED', 9);
    expect(toOwnerReport(input).dishes[0]!.metrics.open_rate.status).toBe('SUPPRESSED');
    const { request, result } = recommend(input);
    expect(request.evidence[0]).toMatchObject({ state: 'suppressed' });
    expect(request.evidence[0]).not.toHaveProperty('value');
    expect(result).toMatchObject({ status: 'abstained', reason: 'suppressed_evidence' });
  });

  it.each([
    { venueId: uuid(99) },
    { dishId: otherDishId },
    { source: 'production' },
    { calculationVersion: 'another.calculation.v1' },
    { generatedAt: '2026-11-03T12:01:00Z' },
    { timeWindow: { ...snapshot().timeWindow, end: '2026-11-04T00:00:00Z' } },
    { timeWindow: { ...snapshot().timeWindow, start: '2026-11-02T00:00:00.000Z' } },
  ])('rejects a trusted snapshot bound to another report tuple: %j', (changed) => {
    expect(() =>
      toOwnerRecommendationRequest(report(), {
        ...scope(),
        snapshot: { ...snapshot(), ...changed },
      }),
    ).toThrow(OwnerAiAuthorizationError);
  });

  it('denies another authorized venue and refuses context reuse for a second selected dish', () => {
    expect(() =>
      toOwnerRecommendationRequest(report(), { ...scope(), authorizedVenueId: uuid(99) }),
    ).toThrow(OwnerAiAuthorizationError);
    const input = report();
    input.dishes.push({ ...structuredClone(input.dishes[0]!), dish_id: otherDishId });
    input.report_metadata.coverage = { total_dishes_monitored: 2, measurable_dishes_count: 2 };
    expect(() => toOwnerRecommendationRequest(input, { ...scope(), dishId: otherDishId })).toThrow(
      OwnerAiAuthorizationError,
    );
  });

  it('rejects public cohort-free reports and ambiguous or extra snapshot identity fields', () => {
    expect(() => toOwnerRecommendationRequest(toOwnerReport(report()), scope())).toThrow();
    for (const changed of [
      { evidenceIds: { ...snapshot().evidenceIds, save_rate: uuid(12) } },
      { reportVersion: 0 },
      { evidenceIds: { ...snapshot().evidenceIds, invented_metric: uuid(15) } },
      { isAuthorized: true },
    ]) {
      expect(() =>
        toOwnerRecommendationRequest(report(), {
          ...scope(),
          snapshot: { ...snapshot(), ...changed },
        }),
      ).toThrow();
    }
  });
});

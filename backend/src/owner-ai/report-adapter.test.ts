import { createHash } from 'node:crypto';
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

// Recompute the shared synthetic vectors in the test; the adapter consumes issued IDs.
function uuidV5ForFixture(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

describe('AI-01 report-to-core consumer adapter', () => {
  it('preserves the shared UUIDv5 report and open-rate evidence IDs through the consumer', () => {
    const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const fixtureVenueId = '00000000-0000-4000-8000-000000000123';
    const fixtureDishId = '00000000-0000-4000-8000-000000000456';
    const reportId = 'c55d819b-5a28-5a39-aaf2-b7c1f9c52230';
    const openRateEvidenceId = '87401dbf-4e82-53fa-832d-b3861fdce02f';
    const reportVersion = 1;
    const timeWindow = { start: '2026-11-01T00:00:00Z', end: '2026-11-08T00:00:00Z' };
    const generatedAt = '2026-11-08T12:00:00Z';
    const calculationVersion = 'calc_v1';
    const input = report();
    input.venue_id = fixtureVenueId;
    input.dishes[0]!.dish_id = fixtureDishId;
    input.report_metadata.calculation_version = calculationVersion;
    input.report_metadata.generated_at = generatedAt;
    input.report_metadata.date_window = {
      start_time: timeWindow.start,
      end_time: timeWindow.end,
      duration_hours: 168,
    };
    input.report_metadata.freshness.last_event_ingested_at = '2026-11-08T00:00:00Z';

    const namePrefix = [input.source, input.schema_version, fixtureVenueId];
    const nameSuffix = [timeWindow.start, timeWindow.end, generatedAt, calculationVersion];
    const evidenceIdFor = (metric: string) =>
      uuidV5ForFixture(namespace, [...namePrefix, fixtureDishId, metric, ...nameSuffix].join('|'));
    expect(
      uuidV5ForFixture(namespace, [...namePrefix, 'all_dishes', ...nameSuffix].join('|')),
    ).toBe(reportId);
    expect(evidenceIdFor('open_rate')).toBe(openRateEvidenceId);

    const request = toOwnerRecommendationRequest(input, {
      authorizedVenueId: fixtureVenueId,
      dishId: fixtureDishId,
      snapshot: {
        ...snapshot(),
        reportId,
        reportVersion,
        venueId: fixtureVenueId,
        dishId: fixtureDishId,
        calculationVersion,
        generatedAt,
        timeWindow,
        evidenceIds: {
          open_rate: openRateEvidenceId,
          engagement_rate: evidenceIdFor('engagement_rate'),
          save_rate: evidenceIdFor('save_rate'),
        },
      },
    });
    expect(request).toMatchObject({ venueId: fixtureVenueId, reportId, reportVersion, timeWindow });
    expect(request.evidence.find(({ metricKey }) => metricKey === 'open_rate')).toMatchObject({
      evidenceId: openRateEvidenceId,
      venueId: fixtureVenueId,
      reportId,
      reportVersion,
      timeWindow,
      state: 'available',
    });

    const openRatePolicy = {
      ...policy,
      rules: [
        {
          ...policy.rules[0]!,
          metricKey: 'open_rate',
          maximumInclusive: 0.6,
          actionId: 'review_dish_card',
        },
      ],
    };
    const result = buildOwnerRecommendation(request, {
      authorizedVenueId: fixtureVenueId,
      policy: openRatePolicy,
    });
    expect(result).toMatchObject({
      status: 'recommendation',
      reportId,
      reportVersion,
      evidenceRefs: [openRateEvidenceId],
    });
    expect(validateOwnerRecommendationResult(result, request, openRatePolicy)).toEqual(result);
  });

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

import { InternalOwnerDishReportSchema, OwnerDishReportSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readOwnerReport } from '../owner-report';
import { buildOwnerRecommendation, validateOwnerRecommendationResult } from './recommendation';
import { toOwnerRecommendationRequest } from './report-adapter';

const projection = vi.hoisted(() => ({ inputs: [] as unknown[] }));

// Observe the actual private constructor at its existing projection seam. Keep the real
// projector: neither internal cohorts nor a test replacement become the public response.
vi.mock('@peekaplate/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@peekaplate/contracts')>();
  return {
    ...actual,
    toOwnerReport(input: unknown) {
      projection.inputs.push(input);
      return actual.toOwnerReport(input);
    },
  };
});

const venueId = '00000000-0000-4000-8000-000000000001';
const dishId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000003';
const now = new Date('2026-11-06T12:00:00.000Z');
const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

// These are authored SQL aggregate rows, not executed SQL or a captured database fixture.
const reportRow = (overrides: Record<string, unknown> = {}) => ({
  dish_id: dishId,
  dish_name: 'Synthetic producer seam dish',
  total_sessions: 20,
  exposed_open_sessions: 12,
  open_eligible_sessions: 12,
  total_openings: 15,
  timed_openings: 12,
  engaged_sessions: 3,
  saved_sessions: 6,
  timed_sessions: 12,
  average_active_seconds: 18,
  last_event_ingested_at: new Date('2026-11-06T11:00:00.000Z'),
  ...overrides,
});

async function readSyntheticReport(row: Record<string, unknown>) {
  // A fake pg response exercises the real reader/builder, not SQL, JWT or membership authority.
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('app_private.staff_membership')) return { rows: [{ permission: 'owner' }] };
    if (sql.includes('app_private.owner_observation_v1')) return { rows: [row] };
    return { rows: [] };
  });
  const publicReport = OwnerDishReportSchema.parse(
    await readOwnerReport({ query } as unknown as Client, actorId, venueId, now, 'synthetic'),
  );
  expect(projection.inputs).toHaveLength(1);
  return {
    publicReport,
    internalReport: InternalOwnerDishReportSchema.parse(projection.inputs[0]),
  };
}

// Explicit synthetic caller-issued identities. They are not derived from report timestamps
// and do not implement the pending production report/evidence identity decision.
const scope = {
  authorizedVenueId: venueId,
  dishId,
  snapshot: {
    requestId: uuid(10),
    reportId: uuid(11),
    reportVersion: 1,
    venueId,
    dishId,
    source: 'synthetic',
    calculationVersion: 'synthetic.v1',
    generatedAt: '2026-11-06T12:00:00.000Z',
    timeWindow: { start: '2026-11-05T12:00:00.000Z', end: '2026-11-06T12:00:00.000Z' },
    evidenceIds: { open_rate: uuid(12), engagement_rate: uuid(13), save_rate: uuid(14) },
  },
};
const policy = {
  schemaVersion: 'owner-recommendation-policy.v1',
  policyVersion: 'producer-seam.synthetic.v1',
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

function expectUnknownFreshnessAbstention(input: unknown) {
  const before = structuredClone(input);
  const request = toOwnerRecommendationRequest(input, scope);
  expect(request).toMatchObject({
    venueId,
    reportId: uuid(11),
    reportVersion: 1,
    timeWindow: scope.snapshot.timeWindow,
  });
  expect(request.evidence.map(({ metricKey, state }) => ({ metricKey, state }))).toEqual([
    { metricKey: 'open_rate', state: 'missing' },
    { metricKey: 'engagement_rate', state: 'missing' },
    { metricKey: 'save_rate', state: 'missing' },
  ]);
  expect(JSON.stringify(request)).not.toMatch(/"value"|eligibleSessions|eligible_sessions/);
  const result = buildOwnerRecommendation(request, { authorizedVenueId: venueId, policy });
  expect(result).toMatchObject({
    status: 'abstained',
    reason: 'missing_evidence',
    evidenceRefs: [uuid(12)],
    approvalRequired: true,
    allowedEffects: [],
  });
  expect(validateOwnerRecommendationResult(result, request, policy)).toEqual(result);
  expect(input).toEqual(before);
}

beforeEach(() => {
  projection.inputs.length = 0;
});

describe('actual owner report constructor to AI consumer (mock SQL, not database acceptance)', () => {
  it.each([
    { label: 'normal Save', saves: 6, value: 0.3, status: 'NORMAL' },
    { label: 'zero Save', saves: 0, value: 0, status: 'VALID_ZERO' },
  ])(
    'withholds real-constructor $label while producer freshness remains unknown',
    async (case_) => {
      const { internalReport, publicReport } = await readSyntheticReport(
        reportRow({ saved_sessions: case_.saves }),
      );
      expect(internalReport).toMatchObject({
        source: 'synthetic',
        report_metadata: {
          calculation_version: 'synthetic.v1',
          generated_at: scope.snapshot.generatedAt,
          freshness: { is_stale: null, last_event_ingested_at: '2026-11-06T11:00:00.000Z' },
        },
      });
      expect(internalReport.dishes[0]?.metrics.save_rate).toEqual({
        value: case_.value,
        status: case_.status,
        eligible_sessions: 20,
      });
      expect(publicReport.dishes[0]?.metrics.save_rate).toEqual({
        value: case_.value,
        status: case_.status,
      });
      expect(JSON.stringify(publicReport)).not.toContain('eligible_sessions');
      expectUnknownFreshnessAbstention(internalReport);
    },
  );

  it('keeps actual complementary disclosure masks and unavailable AI input on a small opened cohort', async () => {
    const { internalReport, publicReport } = await readSyntheticReport(
      reportRow({
        exposed_open_sessions: 1,
        open_eligible_sessions: 1,
        total_openings: 10,
        timed_openings: 0,
        engaged_sessions: 0,
        saved_sessions: 0,
        timed_sessions: 0,
        average_active_seconds: null,
      }),
    );
    expect(internalReport.dishes[0]?.metrics.open_rate).toEqual({
      value: 0.05,
      status: 'NORMAL',
      eligible_sessions: 20,
    });
    expect(internalReport.dishes[0]?.metrics.engagement_rate).toEqual({
      value: null,
      status: 'SUPPRESSED',
      eligible_sessions: 1,
    });
    expect(publicReport.dishes[0]?.metrics).toMatchObject({
      active_sessions: { value: null, status: 'SUPPRESSED' },
      open_rate: { value: null, status: 'SUPPRESSED' },
      timing_coverage: { value: null, status: 'SUPPRESSED' },
      save_rate: { value: 0, status: 'VALID_ZERO' },
    });
    expect(JSON.stringify(publicReport)).not.toContain('eligible_sessions');
    expect(internalReport.report_metadata.freshness.is_stale).toBeNull();
    expectUnknownFreshnessAbstention(internalReport);
  });
});

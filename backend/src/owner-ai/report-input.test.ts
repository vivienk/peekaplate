import { toOwnerReport } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { validateOwnerAiReportInput } from './report-input';

const venueId = '00000000-0000-4000-8000-000000000001';
const dishId = '00000000-0000-4000-8000-000000000002';
const scope = { authorizedVenueId: venueId, dishId };
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
    calculation_version: 'fixture.v1',
    generated_at: '2026-11-03T12:00:00Z',
    date_window: {
      start_time: '2026-11-02T00:00:00Z',
      end_time: '2026-11-03T00:00:00Z',
      duration_hours: 24,
    },
    coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
    freshness: { last_event_ingested_at: '2026-11-03T11:00:00Z', is_stale: false },
    report_status: 'NORMAL',
  },
  dishes: [
    {
      dish_id: dishId,
      name: 'Synthetic dish',
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

describe('AI-01 internal report input validation', () => {
  it('preserves numeric zero, its own cohort, source, dish and time window', () => {
    const input = report();
    const result = validateOwnerAiReportInput(input, scope);
    expect(result.metrics[2]).toEqual({
      metricKey: 'save_rate',
      state: 'available',
      value: 0,
      eligibleSessions: 12,
    });
    expect(result).toMatchObject({
      venueId,
      dishId,
      source: 'synthetic',
      metadata: input.report_metadata,
    });
  });

  it.each([
    ['SUPPRESSED', 9, 'suppressed'],
    ['NOT_MEASURABLE', 0, 'not_measurable'],
    ['MISSING', 0, 'missing'],
    ['STALE', 12, 'stale'],
    ['EVIDENCE_CHECK_FAILED', 12, 'conflicting'],
  ])('withholds %s without converting it into zero', (status, count, state) => {
    const input = report();
    input.dishes[0]!.metrics.save_rate = cell(null, String(status), Number(count));
    expect(validateOwnerAiReportInput(input, scope).metrics[2]).toEqual({
      metricKey: 'save_rate',
      state,
    });
  });

  it.each([9, 10, 11])('uses the metric cohort at the %i boundary', (count) => {
    const input = report();
    input.dishes[0]!.metrics.save_rate = cell(0, 'VALID_ZERO', count);
    if (count < 10) expect(() => validateOwnerAiReportInput(input, scope)).toThrow();
    else
      expect(validateOwnerAiReportInput(input, scope).metrics[2]).toMatchObject({
        value: 0,
        eligibleSessions: count,
      });
  });

  it.each([
    [null, 'VALID_ZERO', 12],
    [0.1, 'VALID_ZERO', 12],
    [0, 'SUPPRESSED', 9],
    [0, 'NOT_MEASURABLE', 0],
  ])('rejects inconsistent value/status %s/%s', (value, status, count) => {
    const input = report();
    input.dishes[0]!.metrics.save_rate = cell(
      value as number | null,
      String(status),
      Number(count),
    );
    expect(() => validateOwnerAiReportInput(input, scope)).toThrow();
  });

  it.each([
    ['STALE', 'stale'],
    ['ERROR', 'conflicting'],
    ['EMPTY', 'missing'],
  ])('global %s prevents locally valid metrics from becoming evidence', (status, state) => {
    const input = report();
    input.report_metadata.report_status = status!;
    expect(
      validateOwnerAiReportInput(input, scope).metrics.every(
        (metric) => metric.state === state && !('value' in metric),
      ),
    ).toBe(true);
  });

  it('honors the stale flag even when report_status is NORMAL', () => {
    const input = report();
    input.report_metadata.freshness.is_stale = true;
    expect(validateOwnerAiReportInput(input, scope).metrics[2]).toEqual({
      metricKey: 'save_rate',
      state: 'stale',
    });
  });

  it('withholds usable metrics when pipeline freshness is unknown', () => {
    const input = report();
    const result = validateOwnerAiReportInput(
      {
        ...input,
        report_metadata: {
          ...input.report_metadata,
          freshness: { ...input.report_metadata.freshness, is_stale: null },
        },
      },
      scope,
    );
    expect(result.metadata.freshness.is_stale).toBeNull();
    expect(result.metrics).toEqual([
      { metricKey: 'open_rate', state: 'missing' },
      { metricKey: 'engagement_rate', state: 'missing' },
      { metricKey: 'save_rate', state: 'missing' },
    ]);
  });

  it('rejects public payloads with hidden cohorts and the unfinished API wrapper', () => {
    expect(() => validateOwnerAiReportInput(toOwnerReport(report()), scope)).toThrow();
    expect(() => validateOwnerAiReportInput({ success: true, data: [] }, scope)).toThrow();
  });

  it('rejects foreign venues, absent dishes and duplicate dish identities', () => {
    const input = report();
    expect(() =>
      validateOwnerAiReportInput(input, { ...scope, authorizedVenueId: dishId }),
    ).toThrow();
    expect(() => validateOwnerAiReportInput(input, { ...scope, dishId: venueId })).toThrow();
    input.dishes.push(structuredClone(input.dishes[0]!));
    expect(() => validateOwnerAiReportInput(input, scope)).toThrow();
  });

  it('keeps identical metric names on different dishes separate', () => {
    const input = report();
    const other = structuredClone(input.dishes[0]!);
    other.dish_id = venueId;
    other.metrics.save_rate = cell(0.8);
    input.dishes.push(other);
    expect(validateOwnerAiReportInput(input, scope).metrics[2]).toMatchObject({ value: 0 });
    expect(
      validateOwnerAiReportInput(input, { ...scope, dishId: venueId }).metrics[2],
    ).toMatchObject({ value: 0.8 });
  });
});

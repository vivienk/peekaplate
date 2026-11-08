import { describe, expect, it } from 'vitest';
import {
  COHORT_METRICS,
  InternalOwnerDishReportSchema,
  MAX_AVERAGE_ACTIVE_SECONDS,
  OwnerDishReportSchema,
  PRIVACY_FLOOR_SESSIONS,
  toOwnerReport,
} from './owner-report';

// One valid synthetic report; each test changes a single field, so a rejection can only come
// from the rule the test names.
type Metric = { value: number | null; status: string };
type Metrics = Record<string, Metric>;

const metric = (value: number | null, status = 'NORMAL'): Metric => ({ value, status });

const validMetrics = (sessions = 12): Metrics => ({
  active_sessions: metric(sessions),
  avg_interaction_time_seconds: metric(30),
  timing_coverage: metric(0.8),
  open_rate: metric(0.5),
  engagement_rate: metric(0.25),
  save_rate: metric(0.1),
});

const suppressedMetrics = (): Metrics =>
  Object.fromEntries(Object.keys(validMetrics()).map((name) => [name, metric(null, 'SUPPRESSED')]));

const report = ({
  metadata = {},
  dish = {},
  metrics = validMetrics(),
  extra = {},
}: {
  metadata?: Record<string, unknown>;
  dish?: Record<string, unknown>;
  metrics?: Metrics;
  extra?: Record<string, unknown>;
} = {}) => ({
  schema_version: 'owner_report.v1',
  venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
  source: 'synthetic',
  report_metadata: {
    calculation_version: 'v1.2.0',
    generated_at: '2026-11-02T10:00:00Z',
    date_window: {
      start_time: '2026-10-26T00:00:00Z',
      end_time: '2026-11-02T00:00:00Z',
      duration_hours: 168,
    },
    coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
    freshness: { last_event_ingested_at: '2026-11-02T09:00:00Z', is_stale: null },
    report_status: 'NORMAL',
    ...metadata,
  },
  dishes: [
    {
      dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
      name: 'Thieb',
      evidence_state: 'NORMAL',
      metrics,
      ...dish,
    },
  ],
  ...extra,
});

const accepts = (input: unknown) => OwnerDishReportSchema.safeParse(input).success;

// The paths of every issue, so a test can check the rejection came from the right field.
const issuePaths = (input: unknown) => {
  const result = OwnerDishReportSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('OwnerDishReportSchema', () => {
  it('accepts a valid synthetic report', () => {
    expect(accepts(report())).toBe(true);
  });

  describe('ADR 0015 privacy floor (ten active sessions)', () => {
    it('uses ten sessions as the floor', () => {
      expect(PRIVACY_FLOOR_SESSIONS).toBe(10);
    });

    it('rejects 9 active sessions shown as NORMAL', () => {
      expect(issuePaths(report({ metrics: validMetrics(9) }))).toEqual([
        'dishes.0.metrics.active_sessions.value',
      ]);
    });

    it('shows 10 and 11 active sessions', () => {
      expect(accepts(report({ metrics: validMetrics(10) }))).toBe(true);
      expect(accepts(report({ metrics: validMetrics(11) }))).toBe(true);
    });

    it('accepts a dish below the floor when every metric is suppressed and null', () => {
      expect(
        accepts(report({ dish: { evidence_state: 'SUPPRESSED' }, metrics: suppressedMetrics() })),
      ).toBe(true);
    });

    it('rejects other metrics with values when active sessions are suppressed', () => {
      const metrics = { ...validMetrics(), active_sessions: metric(null, 'SUPPRESSED') };
      expect(issuePaths(report({ metrics }))).toContain('dishes.0.metrics.open_rate.status');
    });

    it('suppresses a dish with 0 active sessions, since 0 is below the floor', () => {
      expect(
        accepts(report({ dish: { evidence_state: 'SUPPRESSED' }, metrics: suppressedMetrics() })),
      ).toBe(true);
      const zero = { ...suppressedMetrics(), active_sessions: metric(0, 'VALID_ZERO') };
      expect(
        issuePaths(report({ dish: { evidence_state: 'SUPPRESSED' }, metrics: zero })),
      ).toContain('dishes.0.metrics.active_sessions.status');
    });

    it('allows MISSING active sessions only when no other metric shows a value', () => {
      const missing = Object.fromEntries(
        Object.keys(validMetrics()).map((name) => [name, metric(null, 'MISSING')]),
      );
      expect(
        accepts(report({ dish: { evidence_state: 'NOT_MEASURABLE' }, metrics: missing })),
      ).toBe(true);
      const leaky = { ...validMetrics(), active_sessions: metric(null, 'MISSING') };
      expect(issuePaths(report({ metrics: leaky }))).toContain('dishes.0.metrics.save_rate.status');
    });

    it('allows VALID_ZERO for other metrics above the floor (0 saves out of 15 sessions)', () => {
      const metrics = { ...validMetrics(15), save_rate: metric(0, 'VALID_ZERO') };
      expect(accepts(report({ metrics }))).toBe(true);
    });

    it('rejects a suppressed metric that still carries a value', () => {
      const metrics = { ...suppressedMetrics(), active_sessions: metric(9, 'SUPPRESSED') };
      expect(accepts(report({ dish: { evidence_state: 'SUPPRESSED' }, metrics }))).toBe(false);
    });

    it('rejects a SUPPRESSED dish whose metrics are not all suppressed', () => {
      expect(accepts(report({ dish: { evidence_state: 'SUPPRESSED' } }))).toBe(false);
    });
  });

  describe('metric values', () => {
    it('rejects non-integer counts', () => {
      const metrics = { ...validMetrics(), active_sessions: metric(12.5) };
      expect(issuePaths(report({ metrics }))).toContain('dishes.0.metrics.active_sessions.value');
    });

    it('accepts VALID_ZERO only with the value 0', () => {
      const zero = { ...validMetrics(), save_rate: metric(0, 'VALID_ZERO') };
      expect(accepts(report({ metrics: zero }))).toBe(true);
      const five = { ...validMetrics(), avg_interaction_time_seconds: metric(5, 'VALID_ZERO') };
      expect(issuePaths(report({ metrics: five }))).toEqual([
        'dishes.0.metrics.avg_interaction_time_seconds',
      ]);
    });

    it('takes average interaction time in seconds with decimals (plan example 25/3)', () => {
      const metrics = { ...validMetrics(), avg_interaction_time_seconds: metric(25 / 3) };
      expect(accepts(report({ metrics }))).toBe(true);
    });

    it('caps average interaction time at the 300-second per-opening cap', () => {
      expect(MAX_AVERAGE_ACTIVE_SECONDS).toBe(300);
      const atCap = { ...validMetrics(), avg_interaction_time_seconds: metric(300) };
      expect(accepts(report({ metrics: atCap }))).toBe(true);
      const over = { ...validMetrics(), avg_interaction_time_seconds: metric(300.5) };
      expect(issuePaths(report({ metrics: over }))).toContain(
        'dishes.0.metrics.avg_interaction_time_seconds.value',
      );
      const negative = { ...validMetrics(), avg_interaction_time_seconds: metric(-1) };
      expect(accepts(report({ metrics: negative }))).toBe(false);
    });

    it('keeps rates between 0 and 1', () => {
      const metrics = { ...validMetrics(), open_rate: metric(1.5) };
      expect(issuePaths(report({ metrics }))).toContain('dishes.0.metrics.open_rate.value');
    });

    it('requires null for NOT_MEASURABLE (for example a zero denominator)', () => {
      const empty = { ...validMetrics(), open_rate: metric(null, 'NOT_MEASURABLE') };
      expect(accepts(report({ metrics: empty }))).toBe(true);
      const filled = { ...validMetrics(), open_rate: metric(0, 'NOT_MEASURABLE') };
      expect(accepts(report({ metrics: filled }))).toBe(false);
    });
  });

  describe('report metadata', () => {
    it('rejects more measurable dishes than monitored', () => {
      const coverage = { total_dishes_monitored: 1, measurable_dishes_count: 2 };
      expect(accepts(report({ metadata: { coverage } }))).toBe(false);
    });

    it('rejects a window that ends before it starts', () => {
      const date_window = {
        start_time: '2026-11-02T00:00:00Z',
        end_time: '2026-10-26T00:00:00Z',
        duration_hours: 168,
      };
      expect(accepts(report({ metadata: { date_window } }))).toBe(false);
    });

    it('allows no last-event time only for an EMPTY report', () => {
      const freshness = { last_event_ingested_at: null, is_stale: false };
      expect(accepts(report({ metadata: { freshness, report_status: 'EMPTY' } }))).toBe(true);
      expect(accepts(report({ metadata: { freshness } }))).toBe(false);
    });

    it('represents unverified freshness without claiming fresh or stale', () => {
      const freshness = { last_event_ingested_at: '2026-11-02T09:00:00Z', is_stale: null };
      expect(accepts(report({ metadata: { freshness } }))).toBe(true);
    });
  });

  describe('strict shape', () => {
    it('rejects unknown fields', () => {
      expect(accepts(report({ extra: { unknown_field_test: 'triggered' } }))).toBe(false);
      expect(accepts(report({ dish: { performance_score: 9 } }))).toBe(false);
    });

    it('rejects an empty dish name', () => {
      expect(accepts(report({ dish: { name: '' } }))).toBe(false);
    });
  });
});

// Sai, 2 Nov: the floor applies to each metric's own cohort. Rates count the distinct eligible
// sessions in their denominator; averages count the distinct sessions that supplied a valid
// measurement. The internal report carries those counts; owners never see them.
describe('per-metric cohort floor (internal report)', () => {
  type Cell = Metric & { eligible_sessions: number };
  const cell = (value: number | null, status: string, eligible: number): Cell => ({
    ...metric(value, status),
    eligible_sessions: eligible,
  });

  // A 20-session dish where every rate and the average has 20 eligible sessions.
  const internalMetrics = (overrides: Record<string, Cell> = {}) => ({
    active_sessions: metric(20),
    avg_interaction_time_seconds: cell(37, 'NORMAL', 20),
    timing_coverage: cell(0.8, 'NORMAL', 20),
    open_rate: cell(0.5, 'NORMAL', 20),
    engagement_rate: cell(0.25, 'NORMAL', 20),
    save_rate: cell(0.1, 'NORMAL', 20),
    ...overrides,
  });
  const internal = (overrides: Record<string, Cell> = {}, dish: Record<string, unknown> = {}) =>
    report({ metrics: internalMetrics(overrides) as unknown as Metrics, dish });
  const internalPaths = (input: unknown) => {
    const result = InternalOwnerDishReportSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
  };
  const sample: Record<string, number> = {
    avg_interaction_time_seconds: 37,
    timing_coverage: 0.05,
    open_rate: 1,
    engagement_rate: 0.25,
    save_rate: 0.1,
  };

  it('accepts a report where every metric meets its own cohort floor', () => {
    expect(InternalOwnerDishReportSchema.safeParse(internal()).success).toBe(true);
  });

  for (const name of COHORT_METRICS) {
    it(`${name}: 1 and 9 eligible sessions are suppressed, exactly 10 is shown`, () => {
      const value = sample[name] ?? 0;
      for (const eligible of [1, 9]) {
        expect(internalPaths(internal({ [name]: cell(value, 'NORMAL', eligible) }))).toEqual([
          `dishes.0.metrics.${name}.status`,
        ]);
        expect(
          InternalOwnerDishReportSchema.safeParse(
            internal({ [name]: cell(null, 'SUPPRESSED', eligible) }),
          ).success,
        ).toBe(true);
      }
      expect(
        InternalOwnerDishReportSchema.safeParse(internal({ [name]: cell(value, 'NORMAL', 10) }))
          .success,
      ).toBe(true);
    });
  }

  it("rejects Sai's example: a 20-session dish whose average comes from one session", () => {
    const metrics = {
      open_rate: cell(1, 'NORMAL', 20),
      timing_coverage: cell(0.05, 'NORMAL', 20),
      avg_interaction_time_seconds: cell(37, 'NORMAL', 1),
    };
    expect(internalPaths(internal(metrics))).toEqual([
      'dishes.0.metrics.avg_interaction_time_seconds.status',
    ]);
  });

  it('allows a genuine zero above the floor, but not below it', () => {
    const zero = { save_rate: cell(0, 'VALID_ZERO', 15) };
    expect(InternalOwnerDishReportSchema.safeParse(internal(zero)).success).toBe(true);
    const small = { save_rate: cell(0, 'VALID_ZERO', 9) };
    expect(internalPaths(internal(small))).toEqual(['dishes.0.metrics.save_rate.status']);
  });

  it('treats a zero denominator as NOT_MEASURABLE, never 0% or SUPPRESSED', () => {
    const notMeasurable = { open_rate: cell(null, 'NOT_MEASURABLE', 0) };
    expect(InternalOwnerDishReportSchema.safeParse(internal(notMeasurable)).success).toBe(true);
    for (const wrong of [
      cell(0, 'VALID_ZERO', 0),
      cell(0, 'NORMAL', 0),
      cell(null, 'SUPPRESSED', 0),
    ]) {
      expect(internalPaths(internal({ open_rate: wrong }))).toContain(
        'dishes.0.metrics.open_rate.status',
      );
    }
  });

  it('keeps every metric SUPPRESSED on a dish below the floor, even with a zero denominator', () => {
    const suppressed = Object.fromEntries(
      COHORT_METRICS.map((name) => [name, cell(null, 'SUPPRESSED', 0)]),
    );
    const input = internal(
      { ...suppressed, active_sessions: metric(null, 'SUPPRESSED') as Cell },
      { evidence_state: 'SUPPRESSED' },
    );
    expect(InternalOwnerDishReportSchema.safeParse(input).success).toBe(true);
  });

  it('passes the cohort check for 2 openings from 20 eligible sessions (the API still decides)', () => {
    // Complementary suppression is the report API's job: the denominator check alone cannot show
    // that a rate, count or related cell is safe to display.
    const metrics = { open_rate: cell(0.1, 'NORMAL', 20) };
    expect(InternalOwnerDishReportSchema.safeParse(internal(metrics)).success).toBe(true);
  });

  it('toOwnerReport removes every eligible_sessions and the result is a valid owner report', () => {
    const owner = toOwnerReport(internal());
    expect(JSON.stringify(owner)).not.toContain('eligible_sessions');
    expect(OwnerDishReportSchema.safeParse(owner).success).toBe(true);
    expect(owner.dishes[0]?.metrics.save_rate).toEqual({ value: 0.1, status: 'NORMAL' });
  });

  it('toOwnerReport masks timing-derived cells when fewer than ten sessions were timed', () => {
    const owner = toOwnerReport(
      internal({
        avg_interaction_time_seconds: cell(null, 'SUPPRESSED', 9),
        timing_coverage: cell(0.9, 'NORMAL', 10),
        open_rate: cell(1, 'NORMAL', 10),
      }),
    );

    expect(owner.dishes[0]?.evidence_state).toBe('NORMAL');
    expect(owner.dishes[0]?.metrics).toMatchObject({
      active_sessions: { value: null, status: 'SUPPRESSED' },
      avg_interaction_time_seconds: { value: null, status: 'SUPPRESSED' },
      timing_coverage: { value: null, status: 'SUPPRESSED' },
      open_rate: { value: null, status: 'SUPPRESSED' },
      engagement_rate: { value: 0.25, status: 'NORMAL' },
      save_rate: { value: 0.1, status: 'NORMAL' },
    });
    expect(OwnerDishReportSchema.safeParse(owner).success).toBe(true);
    expect(JSON.stringify(owner)).not.toContain('eligible_sessions');
  });

  it('toOwnerReport refuses an internal report that breaks the cohort floor', () => {
    const below = internal({ save_rate: cell(0.5, 'NORMAL', 3) });
    expect(() => toOwnerReport(below)).toThrow();
  });

  it('the owner schema rejects cohort counts, so they cannot be sent to owners', () => {
    expect(OwnerDishReportSchema.safeParse(internal()).success).toBe(false);
  });
});

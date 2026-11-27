import { describe, expect, it, vi } from 'vitest';
import { analyzeOwnerReport } from './owner-ai/responses';
import { evaluateBatchFreshness } from './owner-report-freshness';

const VENUE_ID = '00000000-0000-4000-8000-000000000123';
const DISH_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_START = '2026-11-23T17:45:00.000Z';
const BATCH_END = '2026-11-23T17:50:00.000Z';

function buildReport(isStale: boolean | null, generatedAt: string) {
  return {
    schema_version: 'owner_report.v1' as const,
    venue_id: VENUE_ID,
    source: 'production' as const,
    report_metadata: {
      calculation_version: 'production.batch.v1',
      generated_at: generatedAt,
      date_window: {
        start_time: BATCH_START,
        end_time: BATCH_END,
        duration_hours: 0,
      },
      coverage: {
        total_dishes_monitored: 1,
        measurable_dishes_count: 1,
      },
      freshness: {
        last_event_ingested_at: isStale === null ? null : '2026-11-23T17:49:30.000Z',
        is_stale: isStale,
      },
      report_status: 'NORMAL' as const,
    },
    dishes: [
      {
        dish_id: DISH_ID,
        name: 'Avocado Toast',
        evidence_state: 'NORMAL' as const,
        metrics: {
          active_sessions: { value: 14, status: 'NORMAL' as const },
          avg_interaction_time_seconds: { value: 12, status: 'NORMAL' as const },
          timing_coverage: { value: 0.909, status: 'NORMAL' as const },
          open_rate: { value: 0.714, status: 'NORMAL' as const },
          engagement_rate: { value: 1, status: 'NORMAL' as const },
          save_rate: { value: 0.214, status: 'NORMAL' as const },
        },
      },
    ],
  };
}

describe('DATA-17 evaluateBatchFreshness', () => {
  it('returns FRESH (is_stale=false) only when trusted watermark, queue, DLQ, and PostHog are complete', () => {
    const decision = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:52:00.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:51:00.000Z',
        dlqDepth: 0,
        pendingQueueCount: 0,
        posthogComplete: true,
      },
    });
    expect(decision).toEqual({
      is_stale: false,
      status: 'FRESH',
      reason: 'verified_complete_watermark',
    });
  });

  it('returns STALE (is_stale=true) when watermark exceeds max staleness', () => {
    const decision = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T18:15:00.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:51:00.000Z',
        dlqDepth: 0,
        pendingQueueCount: 0,
        posthogComplete: true,
      },
    });
    expect(decision).toEqual({
      is_stale: true,
      status: 'STALE',
      reason: 'watermark_exceeded_max_staleness',
    });
  });

  it('returns UNKNOWN (is_stale=null) when watermark is absent', () => {
    const decision = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:52:00.000Z'),
      watermark: null,
    });
    expect(decision).toEqual({
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'missing_ingestion_watermark',
    });
  });

  it.each(['2026-11-23T17:48:30.000Z', BATCH_END, '2026-11-23T17:50:59.999Z'])(
    'returns STALE when the watermark %s does not reach the settled cutoff',
    (watermarkAt) => {
      const decision = evaluateBatchFreshness({
        batchWindowStart: BATCH_START,
        batchWindowEnd: BATCH_END,
        now: new Date('2026-11-23T17:52:00.000Z'),
        watermark: {
          source: 'queue_watermark',
          watermarkAt,
          dlqDepth: 0,
          pendingQueueCount: 0,
          posthogComplete: true,
        },
      });
      expect(decision).toEqual({
        is_stale: true,
        status: 'STALE',
        reason: 'delayed_ingestion_watermark_behind_settle_cutoff',
      });
    },
  );

  it.each([{ settleDelayMs: Number.NaN }, { maxStalenessMs: Number.POSITIVE_INFINITY }])(
    'fails closed for nonfinite policy options %j',
    (policy) => {
      expect(
        evaluateBatchFreshness({
          batchWindowStart: BATCH_START,
          batchWindowEnd: BATCH_END,
          now: new Date('2026-11-23T17:52:00.000Z'),
          watermark: null,
          ...policy,
        }),
      ).toEqual({ is_stale: null, status: 'UNKNOWN', reason: 'invalid_window_or_clock' });
    },
  );

  it('fails closed (UNKNOWN) on incomplete processing (DLQ > 0, pending > 0, or PostHog incomplete)', () => {
    const dlqBlocked = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:52:00.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:51:00.000Z',
        dlqDepth: 2,
        pendingQueueCount: 0,
        posthogComplete: true,
      },
    });
    expect(dlqBlocked.is_stale).toBeNull();
    expect(dlqBlocked.reason).toBe('incomplete_queue_processing');

    const pendingBlocked = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:52:00.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:51:00.000Z',
        dlqDepth: 0,
        pendingQueueCount: 5,
        posthogComplete: true,
      },
    });
    expect(pendingBlocked.is_stale).toBeNull();
    expect(pendingBlocked.reason).toBe('incomplete_queue_processing');

    const posthogBlocked = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:52:00.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:51:00.000Z',
        dlqDepth: 0,
        pendingQueueCount: 0,
        posthogComplete: false,
      },
    });
    expect(posthogBlocked.is_stale).toBeNull();
    expect(posthogBlocked.reason).toBe('posthog_reconciliation_incomplete');
  });

  it('fails closed (UNKNOWN) on invalid timestamps or future watermark', () => {
    const invalidWindow = evaluateBatchFreshness({
      batchWindowStart: 'not-a-timestamp',
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:52:00.000Z'),
      watermark: null,
    });
    expect(invalidWindow).toEqual({
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'invalid_window_or_clock',
    });

    const futureWatermark = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:52:00.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:59:00.000Z',
        dlqDepth: 0,
        pendingQueueCount: 0,
        posthogComplete: true,
      },
    });
    expect(futureWatermark).toEqual({
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'invalid_watermark_timestamp',
    });
  });

  it('handles settle delay and replay deterministically', () => {
    const withinSettle = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:50:30.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:50:20.000Z',
        dlqDepth: 0,
        pendingQueueCount: 0,
        posthogComplete: true,
      },
    });
    expect(withinSettle).toEqual({
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'batch_within_settle_delay',
    });

    const afterReplay = evaluateBatchFreshness({
      batchWindowStart: BATCH_START,
      batchWindowEnd: BATCH_END,
      now: new Date('2026-11-23T17:53:00.000Z'),
      watermark: {
        source: 'queue_watermark',
        watermarkAt: '2026-11-23T17:52:30.000Z',
        dlqDepth: 0,
        pendingQueueCount: 0,
        posthogComplete: true,
      },
    });
    expect(afterReplay.is_stale).toBe(false);
  });

  it('AI-03 abstains without provider calls when freshness is unknown or stale', async () => {
    const fetchSpy = vi.fn();
    const reserveSpy = vi.fn(async () => true);

    for (const isStale of [null, true] as const) {
      const result = await analyzeOwnerReport({
        report: buildReport(isStale, '2026-11-23T17:51:00.000Z'),
        venueId: VENUE_ID,
        request: { dishId: DISH_ID, goal: 'engagement' },
        now: new Date('2026-11-23T17:52:00.000Z'),
        apiKey: 'sk-test-unused',
        projectId: 'proj_test',
        fetchImpl: fetchSpy as unknown as typeof fetch,
        reserveRequest: reserveSpy,
      });
      expect(result.status).toBe('abstained');
      if (result.status === 'abstained') {
        expect(result.reason).toBe('unusable_evidence');
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
  });
});

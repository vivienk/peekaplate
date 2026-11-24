import { z } from 'zod';

export const DEFAULT_MAX_BATCH_STALENESS_MS = 15 * 60_000;
export const DEFAULT_BATCH_SETTLE_DELAY_MS = 60_000;

export const IngestionWatermarkSchema = z.strictObject({
  source: z.literal('queue_watermark'),
  watermarkAt: z.iso.datetime({ offset: true }),
  dlqDepth: z.number().int().nonnegative(),
  pendingQueueCount: z.number().int().nonnegative(),
  posthogComplete: z.boolean(),
});

export type IngestionWatermark = z.infer<typeof IngestionWatermarkSchema>;

export type BatchFreshnessStatus = 'FRESH' | 'STALE' | 'UNKNOWN';

export type BatchFreshnessDecision = {
  is_stale: boolean | null;
  status: BatchFreshnessStatus;
  reason: string;
};

export type EvaluateBatchFreshnessInput = {
  batchWindowStart: string;
  batchWindowEnd: string;
  now: Date;
  settleDelayMs?: number;
  maxStalenessMs?: number;
  watermark: IngestionWatermark | null | undefined;
};

function parseUtcMs(value: string): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Evaluates whether a sealed 5-minute production batch has trusted server-side
 * freshness evidence. Fails closed (`is_stale: null`, `UNKNOWN`) whenever
 * watermark evidence is absent, invalid, or indicates incomplete processing.
 */
export function evaluateBatchFreshness(input: EvaluateBatchFreshnessInput): BatchFreshnessDecision {
  const startMs = parseUtcMs(input.batchWindowStart);
  const endMs = parseUtcMs(input.batchWindowEnd);
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const settleDelayMs = input.settleDelayMs ?? DEFAULT_BATCH_SETTLE_DELAY_MS;
  const maxStalenessMs = input.maxStalenessMs ?? DEFAULT_MAX_BATCH_STALENESS_MS;

  if (
    startMs === null ||
    endMs === null ||
    !Number.isFinite(nowMs) ||
    endMs <= startMs ||
    settleDelayMs < 0 ||
    maxStalenessMs <= 0
  ) {
    return {
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'invalid_window_or_clock',
    };
  }

  // Batch has not cleared its settle delay; completeness cannot be attested yet.
  if (nowMs < endMs + settleDelayMs) {
    return {
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'batch_within_settle_delay',
    };
  }

  if (input.watermark === null || input.watermark === undefined) {
    return {
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'missing_ingestion_watermark',
    };
  }

  const parsed = IngestionWatermarkSchema.safeParse(input.watermark);
  if (!parsed.success) {
    return {
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'invalid_ingestion_watermark',
    };
  }

  const watermarkMs = parseUtcMs(parsed.data.watermarkAt);
  if (watermarkMs === null || watermarkMs > nowMs) {
    return {
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'invalid_watermark_timestamp',
    };
  }

  if (parsed.data.dlqDepth > 0 || parsed.data.pendingQueueCount > 0) {
    return {
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'incomplete_queue_processing',
    };
  }

  if (!parsed.data.posthogComplete) {
    return {
      is_stale: null,
      status: 'UNKNOWN',
      reason: 'posthog_reconciliation_incomplete',
    };
  }

  if (watermarkMs < endMs) {
    return {
      is_stale: true,
      status: 'STALE',
      reason: 'delayed_ingestion_watermark_behind_batch_end',
    };
  }

  if (nowMs - watermarkMs > maxStalenessMs) {
    return {
      is_stale: true,
      status: 'STALE',
      reason: 'watermark_exceeded_max_staleness',
    };
  }

  return {
    is_stale: false,
    status: 'FRESH',
    reason: 'verified_complete_watermark',
  };
}

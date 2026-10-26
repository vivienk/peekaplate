import {
  type MenuExtractionResult,
  MenuExtractionResultSchema,
  MenuIngestionQueueMessageSchema,
  type StructuredDishDraft,
} from '@peekaplate/contracts';
import { adaptPythonExtractionResult } from './adapter';
import {
  claimIngestionJob,
  createIngestionJob,
  type DatabaseClient,
  failIngestionJob,
  getIngestionJob,
  IngestionError,
  type MenuIngestionJobRow,
  persistExtractedDrafts,
} from './repository';

export type IngestionRequest = {
  venueId: string;
  sourceType: 'url' | 'pdf' | 'photo' | 'text';
  sourceUrl?: string | null | undefined;
  sourceHash?: string | null | undefined;
  sourceStorageKey?: string | null | undefined;
  idempotencyKey: string;
};

export type PythonExtractor = (job: MenuIngestionJobRow) => Promise<MenuExtractionResult | unknown>;

export type QueueProducer = {
  send(message: unknown): Promise<void>;
};

export type QueueMessage<T = unknown> = {
  id?: string;
  body: T;
  attempts?: number;
  ack(): void;
  retry(): void;
};

export type QueueBatch<T = unknown> = {
  queue?: string;
  messages: readonly QueueMessage<T>[];
};

/**
 * Validates and initiates a menu ingestion job.
 * If queueProducer is supplied, dispatches a versioned MenuIngestionQueueMessage.
 */
export async function submitMenuIngestion(
  client: DatabaseClient,
  request: IngestionRequest,
  queueProducer?: QueueProducer | undefined,
): Promise<MenuIngestionJobRow> {
  // Input validation
  if (!request.venueId || !request.idempotencyKey) {
    throw new IngestionError('invalid_request', 400, 'venueId and idempotencyKey are required');
  }

  if (request.sourceType === 'url') {
    if (!request.sourceUrl) {
      throw new IngestionError('invalid_request', 400, 'sourceUrl is required for url ingestion');
    }
    try {
      const parsed = new URL(request.sourceUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new IngestionError('invalid_url_protocol', 400, 'Only http and https URLs supported');
      }
    } catch {
      throw new IngestionError('malformed_url', 400, 'Invalid URL format');
    }
  } else if (request.sourceType === 'pdf' || request.sourceType === 'photo') {
    if (!request.sourceStorageKey && !request.sourceUrl) {
      throw new IngestionError(
        'missing_source_reference',
        400,
        'sourceStorageKey or sourceUrl required',
      );
    }
  }

  const job = await createIngestionJob(client, {
    tenantId: request.venueId,
    sourceType: request.sourceType,
    sourceUrl: request.sourceUrl ?? null,
    sourceHash: request.sourceHash ?? null,
    sourceStorageKey: request.sourceStorageKey ?? null,
    idempotencyKey: request.idempotencyKey,
  });

  if (queueProducer) {
    try {
      await queueProducer.send({
        version: 1,
        tenantId: request.venueId,
        jobId: job.id,
        queuedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      throw new IngestionError(
        'queue_dispatch_failed',
        500,
        `Failed to enqueue ingestion job: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return job;
}

/**
 * Executes the end-to-end ingestion processing lifecycle for a claimed job:
 * Claim → Extract → Adapt & Validate → Persist Drafts & Complete.
 */
export async function executeIngestionWorkflow(
  client: DatabaseClient,
  params: {
    tenantId: string;
    jobId: string;
    workerId: string;
    extractor: PythonExtractor;
    leaseTimeoutMinutes?: number | undefined;
  },
): Promise<{
  job: MenuIngestionJobRow;
  drafts: StructuredDishDraft[];
  persistedCount: number;
  supersededCount: number;
}> {
  // 1. Claim job lease
  const claim = await claimIngestionJob(client, {
    tenantId: params.tenantId,
    jobId: params.jobId,
    workerId: params.workerId,
    ...(params.leaseTimeoutMinutes !== undefined
      ? { leaseTimeoutMinutes: params.leaseTimeoutMinutes }
      : {}),
  });

  if (!claim) {
    const existing = await getIngestionJob(client, params.tenantId, params.jobId);
    if (!existing) throw new IngestionError('job_not_found', 404);
    throw new IngestionError('job_already_locked_or_complete', 409);
  }

  const job = (await getIngestionJob(client, params.tenantId, params.jobId))!;

  try {
    // 2. Call Python extraction boundary
    const rawResult = await params.extractor(job);

    // 3. Adapt and validate output against contract
    const adapted = adaptPythonExtractionResult(rawResult);

    if (!adapted.success || adapted.status === 'failed') {
      const errorMsg = !adapted.success
        ? adapted.errors.join('; ')
        : adapted.warnings.join('; ') || 'Extraction marked as failed by producer';
      await failIngestionJob(client, {
        tenantId: params.tenantId,
        jobId: params.jobId,
        claimToken: claim.claimToken,
        errorCode: !adapted.success ? 'schema_validation_failed' : 'extraction_failed',
        errorDetails: errorMsg,
        ...(params.leaseTimeoutMinutes !== undefined
          ? { leaseTimeoutMinutes: params.leaseTimeoutMinutes }
          : {}),
      });

      const failedJob = (await getIngestionJob(client, params.tenantId, params.jobId))!;
      return {
        job: failedJob,
        drafts: [],
        persistedCount: 0,
        supersededCount: 0,
      };
    }

    // 4. Persist drafts under transaction fencing
    const targetStatus = adapted.status === 'incomplete' ? 'incomplete' : 'complete';
    const persistenceResult = await persistExtractedDrafts(client, {
      tenantId: params.tenantId,
      jobId: params.jobId,
      claimToken: claim.claimToken,
      drafts: adapted.drafts,
      status: targetStatus,
      ...(params.leaseTimeoutMinutes !== undefined
        ? { leaseTimeoutMinutes: params.leaseTimeoutMinutes }
        : {}),
    });

    const completedJob = (await getIngestionJob(client, params.tenantId, params.jobId))!;
    return {
      job: completedJob,
      drafts: adapted.drafts,
      persistedCount: persistenceResult.persistedCount,
      supersededCount: persistenceResult.supersededCount,
    };
  } catch (error) {
    const errorCode = error instanceof IngestionError ? error.code : 'extraction_exception';
    const errorDetails = error instanceof Error ? error.message : String(error);

    await failIngestionJob(client, {
      tenantId: params.tenantId,
      jobId: params.jobId,
      claimToken: claim.claimToken,
      errorCode,
      errorDetails,
      ...(params.leaseTimeoutMinutes !== undefined
        ? { leaseTimeoutMinutes: params.leaseTimeoutMinutes }
        : {}),
    });

    throw error;
  }
}

/**
 * Processes a Cloudflare Queue batch of menu ingestion messages.
 *
 * Guarantees:
 * 1. Poison/malformed messages are acknowledged with logged errors to prevent poison loops.
 * 2. Duplicate deliveries for running or completed jobs are acknowledged safely.
 * 3. Successful extraction and draft persistence acknowledge the message.
 * 4. Transient/retryable exceptions trigger message retry.
 */
export async function processIngestionQueueBatch(
  client: DatabaseClient,
  batch: { messages: readonly QueueMessage<unknown>[] },
  extractor: PythonExtractor,
  options?: {
    workerId?: string;
    leaseTimeoutMinutes?: number;
  },
): Promise<{
  processed: number;
  acknowledged: number;
  retried: number;
  errors: Array<{ jobId?: string; error: string }>;
}> {
  let processed = 0;
  let acknowledged = 0;
  let retried = 0;
  const errors: Array<{ jobId?: string; error: string }> = [];

  for (const msg of batch.messages) {
    const parseResult = MenuIngestionQueueMessageSchema.safeParse(msg.body);
    if (!parseResult.success) {
      msg.ack();
      acknowledged += 1;
      errors.push({
        error: `Invalid queue message: ${parseResult.error.message}`,
      });
      continue;
    }

    const { tenantId, jobId } = parseResult.data;

    try {
      await executeIngestionWorkflow(client, {
        tenantId,
        jobId,
        workerId: options?.workerId ?? 'cf-queue-worker',
        extractor,
        ...(options?.leaseTimeoutMinutes !== undefined
          ? { leaseTimeoutMinutes: options.leaseTimeoutMinutes }
          : {}),
      });

      msg.ack();
      acknowledged += 1;
      processed += 1;
    } catch (err: unknown) {
      if (err instanceof IngestionError) {
        if (err.code === 'job_already_locked_or_complete') {
          // Duplicate queue delivery while active lease or completed: ACK safely
          msg.ack();
          acknowledged += 1;
          continue;
        }
        if (err.code === 'job_not_found') {
          msg.ack();
          acknowledged += 1;
          errors.push({ jobId, error: 'Job not found' });
          continue;
        }
      }

      // Transient or unexpected error: retry delivery
      msg.retry();
      retried += 1;
      errors.push({
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { processed, acknowledged, retried, errors };
}

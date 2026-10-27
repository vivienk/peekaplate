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

export type ReportStorage = {
  put(key: string, data: string): Promise<void>;
  get?(key: string): Promise<string | null>;
};

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

  // Reject unmaterialized URL and raw text sources at submission boundary
  if (request.sourceType === 'url' || request.sourceType === 'text') {
    throw new IngestionError(
      'unsupported_source_type',
      400,
      `Source type "${request.sourceType}" is not supported for direct extraction. URL and text menu ingestion requires prior retrieval materialization to private R2. Please submit 'pdf' or 'photo' with sourceHash and sourceStorageKey.`,
    );
  }

  // PDF and photo sources require SHA-256 hash
  if (!request.sourceHash || !/^[0-9a-f]{64}$/.test(request.sourceHash)) {
    throw new IngestionError(
      'missing_source_hash',
      400,
      'A valid 64-character SHA-256 hex sourceHash is required for menu extraction',
    );
  }

  const jobId = crypto.randomUUID();
  const canonicalSourceKey = `menu-ingestion/sources/${request.venueId}/${jobId}/source`;
  let sourceStorageKey = canonicalSourceKey;

  if (request.sourceStorageKey) {
    if (request.sourceStorageKey.includes('..') || request.sourceStorageKey.startsWith('/')) {
      throw new IngestionError(
        'invalid_source_storage_key',
        400,
        'Invalid source storage key format',
      );
    }
    // Prevent cross-tenant arbitrary object access
    const tenantScopeMatch = request.sourceStorageKey.match(
      /(?:menu-ingestion\/)?sources\/([0-9a-f-]{36})\//i,
    );
    if (tenantScopeMatch && tenantScopeMatch[1] && tenantScopeMatch[1] !== request.venueId) {
      throw new IngestionError(
        'unauthorized_source_storage_key',
        400,
        'Source storage key must match the authorized venue scope',
      );
    }
    sourceStorageKey = request.sourceStorageKey;
  }

  const job = await createIngestionJob(client, {
    id: jobId,
    tenantId: request.venueId,
    sourceType: request.sourceType,
    sourceUrl: request.sourceUrl ?? null,
    sourceHash: request.sourceHash,
    sourceStorageKey,
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
    reportStorage?: ReportStorage | undefined;
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

    // 4. Durably retain complete private report and timing artifact if storage is configured
    let resultStorageKey: string | null = null;
    if (params.reportStorage) {
      resultStorageKey = `reports/${params.tenantId}/${params.jobId}/extraction.json`;
      try {
        await params.reportStorage.put(resultStorageKey, JSON.stringify(rawResult));
      } catch (storageErr) {
        throw new IngestionError(
          'report_storage_failed',
          500,
          `Failed to persist extraction report artifact: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
        );
      }
    }

    // 5. Persist drafts under transaction fencing
    const targetStatus = adapted.status === 'incomplete' ? 'incomplete' : 'complete';
    const persistenceResult = await persistExtractedDrafts(client, {
      tenantId: params.tenantId,
      jobId: params.jobId,
      claimToken: claim.claimToken,
      drafts: adapted.drafts,
      status: targetStatus,
      resultStorageKey,
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
    reportStorage?: ReportStorage;
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
      const workflowOutcome = await executeIngestionWorkflow(client, {
        tenantId,
        jobId,
        workerId: options?.workerId ?? 'cf-queue-worker',
        extractor,
        ...(options?.reportStorage !== undefined ? { reportStorage: options.reportStorage } : {}),
        ...(options?.leaseTimeoutMinutes !== undefined
          ? { leaseTimeoutMinutes: options.leaseTimeoutMinutes }
          : {}),
      });

      if (workflowOutcome.job.status === 'queued') {
        msg.retry();
        retried += 1;
        errors.push({
          jobId,
          error: `Job requeued for retry: ${workflowOutcome.job.error_code ?? 'unknown_error'}`,
        });
      } else {
        msg.ack();
        acknowledged += 1;
        processed += 1;
      }
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

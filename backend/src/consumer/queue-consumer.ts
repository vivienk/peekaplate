import {
  ObservationConflictV1QueueEnvelopeSchema,
  ObservationQueueEnvelopeSchema,
  ObservationV2QueueEnvelopeSchema,
} from '@peekaplate/contracts';
import { canonicalizeJson, sha256Hex } from './canonical-json';
import {
  ALLOWED_EVENT_TYPES,
  type AllowedEventType,
  buildConflictArchiveKey,
  buildRawArchiveKey,
  type ConflictObservationEnvelope,
  type NormalObservationEnvelope,
  type ObservationEnvelope,
  type ObservationRepository,
  type QueueObservationEnvelope,
  type R2ArchiveStorage,
} from './types';

/**
 * Message disposition after consumer processing.
 */
export type MessageDisposition =
  | { status: 'acknowledged'; reason: 'persisted' | 'duplicate_same_payload' | 'conflict_recorded' }
  | { status: 'retry'; error: Error }
  | { status: 'dead_letter'; reason: string };

export class MalformedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedMessageError';
  }
}

function formatValidationError(
  raw: unknown,
  error: { issues: readonly { path?: readonly PropertyKey[]; message?: string }[] },
): string {
  const issue = error.issues[0];
  if (!issue) return 'Validation failed';
  const path = String(issue.path?.[0] ?? '');
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (path === 'tenantId') return 'Missing or invalid tenantId: must be a valid UUID';
  if (path === 'eventId') return 'Missing or invalid eventId: must be a valid UUID';
  if (path === 'authorizedPublicationId')
    return 'Missing or invalid authorizedPublicationId: must be a valid UUID';
  if (path === 'schemaVersion')
    return `Unsupported schemaVersion: expected 'observation.v2', got ${JSON.stringify(r.schemaVersion)}`;
  if (path === 'type') return `Unsupported observation type: ${r.type}`;
  if (path === 'occurredAt') return 'Missing or invalid occurredAt timestamp';
  if (path === 'firstReceivedAt') return 'Missing or invalid firstReceivedAt timestamp';
  if (path === 'incomingChecksum')
    return 'Invalid incomingChecksum: must be a 64-character hex string';
  if (path === 'kind') return `Unsupported envelope kind: ${r.kind}`;
  return `${issue.path ? issue.path.map(String).join('.') : ''}: ${issue.message ?? 'Unknown validation issue'}`;
}

/**
 * Minimal Cloudflare Queue Message interface.
 */
export interface QueueMessage<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/**
 * Minimal Cloudflare MessageBatch interface.
 */
export interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

/**
 * Validates and extracts the normal observation envelope from a Queue message body.
 * Adheres strictly to ADR 0015 & PR #32:
 * - Transport identity is (tenant_id, event_id), where tenant_id is the server-derived venue_id.
 * - authorized_publication_id is the server-derived UUID required for provenance.
 * - schema_version must be 'observation.v2' (string).
 * - type must be an allowed P0 event type.
 * - session_id is preserved for downstream fact flows.
 * - producer_id and local_sequence are preserved from the producer handoff.
 */
export function validateObservationEnvelope(body: unknown): NormalObservationEnvelope {
  if (!body || typeof body !== 'object') {
    throw new MalformedMessageError('Message body must be an object');
  }

  const parsed = ObservationV2QueueEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new MalformedMessageError(formatValidationError(body, parsed.error));
  }

  return {
    ...parsed.data,
    venueId: parsed.data.tenantId,
  };
}

/**
 * Validates and extracts the observation conflict envelope from a Queue message body.
 * Adheres to ADR 0015 & PR #40:
 * - kind: 'observation_conflict.v1'
 * - tenantId: UUID
 * - eventId: UUID
 * - authorizedPublicationId: UUID
 * - Preserves incomingChecksum, payload, conflictReason, occurredAt, receivedAt, boundedMetadata
 */
export function validateConflictObservationEnvelope(body: unknown): ConflictObservationEnvelope {
  if (!body || typeof body !== 'object') {
    throw new MalformedMessageError('Message body must be an object');
  }

  const parsed = ObservationConflictV1QueueEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new MalformedMessageError(formatValidationError(body, parsed.error));
  }

  return {
    ...parsed.data,
    venueId: parsed.data.tenantId,
  };
}

/**
 * Validates any supported Queue envelope variant ('observation.v2' or 'observation_conflict.v1').
 * Ensures conflict messages are never passed to the normal observation parser.
 */
export function validateQueueEnvelope(body: unknown): QueueObservationEnvelope {
  if (!body || typeof body !== 'object') {
    throw new MalformedMessageError('Message body must be an object');
  }

  const parsed = ObservationQueueEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new MalformedMessageError(formatValidationError(body, parsed.error));
  }

  return {
    ...parsed.data,
    venueId: parsed.data.tenantId,
  };
}

export type QueueConsumerDependencies = {
  r2Storage: R2ArchiveStorage;
  repository: ObservationRepository;
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
  onTrace?: (operation: string, meta?: Record<string, unknown>) => void;
};

/**
 * Core Queue Consumer service that processes individual messages and batches.
 */
export class QueueConsumer {
  constructor(private readonly deps: QueueConsumerDependencies) {}

  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
    if (this.deps.log) {
      this.deps.log(level, message, meta);
    }
  }

  private trace(operation: string, meta?: Record<string, unknown>) {
    if (this.deps.onTrace) {
      this.deps.onTrace(operation, meta);
    }
  }

  /**
   * Processes a single observation message according to the strict architectural sequence:
   * 1. Validate envelope variant ('observation.v2' or 'observation_conflict.v1').
   * 2. Canonicalize payload and compute deterministic SHA-256 checksum.
   * 3. Archive raw payload to R2 first using create-only semantics.
   *    (If a conflicting payload is detected, archive under a distinct conflict key).
   * 4. Persist canonical observation in Postgres (idempotently with forced RLS).
   * 5. Handle duplicate or conflict outcomes without rewriting original records.
   * 6. Return appropriate disposition.
   */
  async processMessage(body: unknown): Promise<MessageDisposition> {
    // Step 1: Validate envelope
    let envelope: QueueObservationEnvelope;
    try {
      envelope = validateQueueEnvelope(body);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'Unknown validation error';
      this.log('error', 'Malformed message received, routing to dead letter', { reason });
      return { status: 'dead_letter', reason };
    }

    if (envelope.kind === 'observation_conflict.v1') {
      return this.processConflictMessage(envelope, body);
    }

    const {
      tenantId,
      eventId,
      sessionId,
      occurredAt,
      schemaVersion,
      type,
      authorizedPublicationId,
      payload,
      firstReceivedAt,
    } = envelope;

    // Step 2: Canonicalize and hash content
    const canonicalStr = canonicalizeJson(payload);
    const checksum = await sha256Hex(canonicalStr);

    // Raw bytes of the payload for R2 archival
    let rawBytes: Uint8Array;
    if (typeof body === 'string') {
      rawBytes = new TextEncoder().encode(body);
    } else if (body instanceof Uint8Array) {
      rawBytes = body;
    } else {
      rawBytes = new TextEncoder().encode(JSON.stringify(body));
    }

    let archiveKey: string;
    try {
      archiveKey = buildRawArchiveKey(tenantId, eventId, occurredAt);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'Invalid archive key';
      this.log('error', 'Malformed message key, routing to dead letter', { reason });
      return { status: 'dead_letter', reason };
    }

    // Step 3: Archive to R2 FIRST (Create-only)
    try {
      this.trace('r2.put', { archiveKey, checksum });
      const r2Result = await this.deps.r2Storage.putRawPayload(archiveKey, rawBytes, checksum);
      if (r2Result.status === 'already_exists') {
        this.log('info', 'R2 archive key already exists on retry/duplicate', {
          archiveKey,
          existingChecksum: r2Result.existingChecksum,
        });

        // If existing archive has a DIFFERENT checksum, this is a conflict!
        if (r2Result.existingChecksum && r2Result.existingChecksum !== checksum) {
          this.log('warn', 'R2 archive checksum discrepancy detected - archiving to conflict key', {
            tenantId,
            eventId,
            incomingChecksum: checksum,
            existingChecksum: r2Result.existingChecksum,
          });

          // Write conflicting payload to its own distinct, deterministic R2 key
          const conflictArchiveKey = buildConflictArchiveKey(
            tenantId,
            eventId,
            occurredAt,
            checksum,
          );
          await this.deps.r2Storage.putRawPayload(conflictArchiveKey, rawBytes, checksum);

          this.trace('db.recordConflict', { tenantId, eventId });
          const conflictOutcome = await this.deps.repository.recordConflict({
            tenantId,
            eventId,
            incomingChecksum: checksum,
            r2ArchiveKey: conflictArchiveKey,
            receivedAt: firstReceivedAt ?? new Date().toISOString(),
          });

          return {
            status: 'acknowledged',
            reason: conflictOutcome.alreadyRecorded
              ? 'duplicate_same_payload'
              : 'conflict_recorded',
          };
        }
      }
    } catch (err: unknown) {
      // Transient R2 failure -> retry message
      const error = err instanceof Error ? err : new Error(String(err));
      this.log('error', 'R2 raw archive write failed, triggering retry', {
        tenantId,
        eventId,
        error: error.message,
      });
      return { status: 'retry', error };
    }

    // Step 4 & 5: Persist canonical observation in database
    try {
      this.trace('db.persistCanonical', { tenantId, eventId });
      const outcome = await this.deps.repository.persistCanonical({
        tenantId,
        eventId,
        sessionId,
        schemaVersion,
        eventType: type,
        authorizedPublicationId,
        occurredAt,
        firstReceivedAt: firstReceivedAt ?? new Date().toISOString(),
        checksum,
        r2ArchiveKey: archiveKey,
        payload,
      });

      if (outcome.disposition === 'accepted') {
        this.log('info', 'Canonical observation accepted and persisted', { tenantId, eventId });
        return { status: 'acknowledged', reason: 'persisted' };
      }

      if (outcome.disposition === 'rejected') {
        this.log('info', 'Canonical observation rejected per business rules and persisted', {
          tenantId,
          eventId,
          reasonCode: outcome.reasonCode,
        });
        return { status: 'acknowledged', reason: 'persisted' };
      }

      if (outcome.disposition === 'duplicate') {
        this.log('info', 'Duplicate observation received with identical payload', {
          tenantId,
          eventId,
        });
        return { status: 'acknowledged', reason: 'duplicate_same_payload' };
      }

      if (outcome.disposition === 'conflict') {
        this.log('warn', 'Event identity conflict detected in DB - recording in conflict table', {
          tenantId,
          eventId,
          conflictReason: outcome.conflictReason,
        });

        // Write conflicting payload to its own distinct, deterministic R2 key
        const conflictArchiveKey = buildConflictArchiveKey(tenantId, eventId, occurredAt, checksum);
        await this.deps.r2Storage.putRawPayload(conflictArchiveKey, rawBytes, checksum);

        this.trace('db.recordConflict', { tenantId, eventId });
        const conflictOutcome = await this.deps.repository.recordConflict({
          tenantId,
          eventId,
          incomingChecksum: checksum,
          r2ArchiveKey: conflictArchiveKey,
          receivedAt: firstReceivedAt ?? new Date().toISOString(),
        });

        return {
          status: 'acknowledged',
          reason: conflictOutcome.alreadyRecorded ? 'duplicate_same_payload' : 'conflict_recorded',
        };
      }

      return { status: 'acknowledged', reason: 'persisted' };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log('error', 'Database persistence failed, triggering retry', {
        tenantId,
        eventId,
        error: error.message,
      });
      return { status: 'retry', error };
    }
  }

  /**
   * Processes an incoming observation_conflict.v1 message from the Queue.
   * Conforms to ADR 0015 / PR #40:
   * 1. Generates deterministic conflict archive key based on (tenantId, eventId, occurredAt, incomingChecksum).
   * 2. Archives conflicting raw payload or bounded metadata to R2 using atomic create-only writes.
   * 3. Records conflict in PostgreSQL (app_private.observation_conflict) with forced RLS and transaction isolation.
   * 4. Acknowledges message ONLY after durable archival and persistence succeed.
   * 5. Retries on transient R2 or database failures without corrupting existing state.
   */
  private async processConflictMessage(
    envelope: ConflictObservationEnvelope,
    body: unknown,
  ): Promise<MessageDisposition> {
    const { tenantId, eventId, authorizedPublicationId } = envelope;

    const occurredAt =
      envelope.occurredAt ??
      envelope.firstReceivedAt ??
      envelope.receivedAt ??
      new Date().toISOString();
    const receivedAt =
      envelope.firstReceivedAt ??
      envelope.receivedAt ??
      envelope.occurredAt ??
      new Date().toISOString();

    // If conflict envelope carries multiple conflicting copies from producer (ADR 0015 / S3-DATA-01)
    if (envelope.copies && envelope.copies.length > 0) {
      let anyNewRecorded = false;
      for (const copy of envelope.copies) {
        const copyChecksum = copy.canonicalChecksum;
        const copyBytes = new TextEncoder().encode(
          JSON.stringify(copy.event ?? copy.metadata ?? copy),
        );
        let copyArchiveKey: string;
        try {
          copyArchiveKey = buildConflictArchiveKey(tenantId, eventId, occurredAt, copyChecksum);
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : 'Invalid conflict archive key';
          this.log('error', 'Malformed conflict archive key, routing to dead letter', { reason });
          return { status: 'dead_letter', reason };
        }

        // 1. Archive copy to R2 first (Create-only)
        try {
          this.trace('r2.put', { copyArchiveKey, checksum: copyChecksum });
          await this.deps.r2Storage.putRawPayload(copyArchiveKey, copyBytes, copyChecksum);
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.log('error', 'R2 conflict copy archive write failed, triggering retry', {
            tenantId,
            eventId,
            error: error.message,
          });
          return { status: 'retry', error };
        }

        // 2. Persist in PostgreSQL (app_private.observation_conflict)
        try {
          this.trace('db.recordConflict', { tenantId, eventId, checksum: copyChecksum });
          const outcome = await this.deps.repository.recordConflict({
            tenantId,
            eventId,
            incomingChecksum: copyChecksum,
            r2ArchiveKey: copyArchiveKey,
            receivedAt,
          });
          if (!outcome.alreadyRecorded) anyNewRecorded = true;
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.log('error', 'Conflict copy DB persistence failed, triggering retry', {
            tenantId,
            eventId,
            error: error.message,
          });
          return { status: 'retry', error };
        }
      }

      return {
        status: 'acknowledged',
        reason: anyNewRecorded ? 'conflict_recorded' : 'duplicate_same_payload',
      };
    }

    let checksum = envelope.incomingChecksum;
    let rawBytes: Uint8Array;

    if (envelope.payload && typeof envelope.payload === 'object') {
      const canonicalStr = canonicalizeJson(envelope.payload);
      const computedChecksum = await sha256Hex(canonicalStr);
      checksum = checksum ?? computedChecksum;
      if (typeof body === 'string') {
        rawBytes = new TextEncoder().encode(body);
      } else if (body instanceof Uint8Array) {
        rawBytes = body;
      } else {
        rawBytes = new TextEncoder().encode(JSON.stringify(envelope.payload));
      }
    } else {
      // Bounded metadata for invalid copies: excludes arbitrary fields, retains only authorized metadata
      const bounded = envelope.boundedMetadata ?? {
        tenantId,
        eventId,
        authorizedPublicationId,
        conflictReason: envelope.conflictReason ?? envelope.reasonCode ?? 'event_id_conflict',
        receivedAt,
      };
      if (!checksum || !/^[0-9a-f]{64}$/i.test(checksum)) {
        checksum = await sha256Hex(canonicalizeJson(bounded));
      }
      rawBytes = new TextEncoder().encode(JSON.stringify(bounded));
    }

    let conflictArchiveKey: string;
    try {
      conflictArchiveKey = buildConflictArchiveKey(tenantId, eventId, occurredAt, checksum);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'Invalid conflict archive key';
      this.log('error', 'Malformed conflict archive key, routing to dead letter', { reason });
      return { status: 'dead_letter', reason };
    }

    // Step 1: Archive conflict payload to R2 first (Create-only)
    try {
      this.trace('r2.put', { conflictArchiveKey, checksum });
      const r2Result = await this.deps.r2Storage.putRawPayload(
        conflictArchiveKey,
        rawBytes,
        checksum,
      );
      if (r2Result.status === 'already_exists') {
        this.log('info', 'Conflict R2 archive key already exists on retry/duplicate', {
          conflictArchiveKey,
          existingChecksum: r2Result.existingChecksum,
        });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log('error', 'R2 conflict archive write failed, triggering retry', {
        tenantId,
        eventId,
        error: error.message,
      });
      return { status: 'retry', error };
    }

    // Step 2: Persist conflict record in PostgreSQL (app_private.observation_conflict)
    try {
      this.trace('db.recordConflict', { tenantId, eventId });
      const conflictOutcome = await this.deps.repository.recordConflict({
        tenantId,
        eventId,
        incomingChecksum: checksum,
        r2ArchiveKey: conflictArchiveKey,
        receivedAt,
      });

      this.log('info', 'Conflict observation processed and recorded in DB', {
        tenantId,
        eventId,
        alreadyRecorded: conflictOutcome.alreadyRecorded,
      });

      return {
        status: 'acknowledged',
        reason: conflictOutcome.alreadyRecorded ? 'duplicate_same_payload' : 'conflict_recorded',
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log('error', 'Conflict database persistence failed, triggering retry', {
        tenantId,
        eventId,
        error: error.message,
      });
      return { status: 'retry', error };
    }
  }

  /**
   * Processes a Cloudflare MessageBatch handling per-message success and partial batch failures independently.
   * Successful messages are acknowledged individually; failed messages are retried.
   */
  async processBatch(batch: MessageBatch<unknown>): Promise<{
    processed: number;
    acknowledged: number;
    retried: number;
    deadLettered: number;
  }> {
    let acknowledged = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const msg of batch.messages) {
      const disposition = await this.processMessage(msg.body);

      if (disposition.status === 'acknowledged') {
        this.trace('msg.ack', { id: msg.id });
        msg.ack();
        acknowledged++;
      } else if (disposition.status === 'retry') {
        this.trace('msg.retry', { id: msg.id });
        msg.retry();
        retried++;
      } else if (disposition.status === 'dead_letter') {
        // According to Cloudflare Queues semantics, unacknowledged or rejected messages
        // must NOT be prematurely acknowledged with ack(), as ack() permanently deletes
        // the message and prevents it from reaching the configured dead-letter queue (DLQ).
        // Instead, we mark it for retry so that upon retry exhaustion (attempts >= max_retries),
        // Cloudflare Queues automatically delivers the failed message to the DLQ.
        this.trace('msg.dead_letter', { id: msg.id, reason: disposition.reason });
        msg.retry();
        retried++;
        deadLettered++;
      }
    }

    return {
      processed: batch.messages.length,
      acknowledged,
      retried,
      deadLettered,
    };
  }
}

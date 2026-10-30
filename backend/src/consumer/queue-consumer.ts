import {
  ConflictMetadataSchema,
  canonicalJson,
  ObservationConflictQueueMessageSchema,
  ObservationQueueEnvelopeSchema,
  ObservationQueueMessageSchema,
  ObservationV2Schema,
  sha256,
  toCanonicalObservation,
} from '@peekaplate/contracts';
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

interface ValidationIssueItem {
  readonly path?: readonly PropertyKey[];
  readonly message?: string;
  readonly code?: string;
}

function formatValidationError(
  raw: unknown,
  error: { issues: readonly ValidationIssueItem[] },
): string {
  let issue: ValidationIssueItem | undefined = error.issues[0];
  if (!issue) return 'Validation failed';

  // If this is a Zod union error, unwrap the issues from the relevant union branch
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawIssue = issue as {
    code?: string;
    errors?: readonly { issues: readonly ValidationIssueItem[] }[];
  };
  if (rawIssue.code === 'invalid_union' && Array.isArray(rawIssue.errors)) {
    const branchErrors = rawIssue.errors.map((e) => e.issues ?? []);
    if (r.kind === 'observation_conflict.v1' && branchErrors[1]?.[0]) {
      issue =
        branchErrors[1].find((i: ValidationIssueItem) => String(i.path?.[0] ?? '') !== 'kind') ??
        branchErrors[1][0];
    } else if (branchErrors[0]?.[0]) {
      issue =
        branchErrors[0].find((i: ValidationIssueItem) => String(i.path?.[0] ?? '') !== 'kind') ??
        branchErrors[0][0];
    }
  }

  if (!issue) return 'Validation failed';

  const path = String(issue.path?.[0] ?? '');
  if (path === 'tenantId') return 'Missing or invalid tenantId: must be a valid UUID';
  if (path === 'eventId') return 'Missing or invalid eventId: must be a valid UUID';
  if (path === 'authorizedPublicationId')
    return 'Missing or invalid authorizedPublicationId: must be a valid UUID';
  if (path === 'schemaVersion') return "Unsupported schemaVersion: expected 'observation.v2'";
  if (path === 'type') return 'Unsupported observation type';
  if (path === 'occurredAt') return 'Missing or invalid occurredAt timestamp';
  if (path === 'firstReceivedAt') return 'Missing or invalid firstReceivedAt timestamp';
  if (path === 'incomingChecksum')
    return 'Invalid incomingChecksum: must be a 64-character hex string';
  if (path === 'kind') return 'Unsupported envelope kind';
  if (path === 'payload') return 'Invalid observation payload';
  if (path === 'copies') return 'Invalid conflict copies: must contain between 2 and 25 copies';
  return path ? `Invalid or missing field: ${path}` : 'Validation check failed';
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

  const parsed = ObservationQueueMessageSchema.safeParse(body);
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

  const parsed = ObservationConflictQueueMessageSchema.safeParse(body);
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

    // Step 2: Canonicalize and hash COMPLETE CANONICAL OBSERVATION
    // As required by ADR 0015 & PR #40, hashing includes all contract-defined fields
    // that affect observation identity (schemaVersion, eventId, sessionId, producerId,
    // localSequence, occurredAt, authorizedPublicationId, type, payload).
    // Isolate serialization and archive-key construction to protect the batch from unhandled crashes.
    let canonicalStr: string;
    let checksum: string;
    let rawBytes: Uint8Array;
    let archiveKey: string;
    let canonicalObservation: ReturnType<typeof toCanonicalObservation>;

    try {
      canonicalObservation = toCanonicalObservation(envelope);
      canonicalStr = canonicalJson(canonicalObservation);
      checksum = await sha256(canonicalStr);

      // Raw bytes of the payload for R2 archival
      if (typeof body === 'string') {
        rawBytes = new TextEncoder().encode(body);
      } else if (body instanceof Uint8Array) {
        rawBytes = body;
      } else {
        rawBytes = new TextEncoder().encode(JSON.stringify(body));
      }

      archiveKey = buildRawArchiveKey(tenantId, eventId, occurredAt);
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message : 'Invalid canonical observation or archive key';
      this.log('error', 'Malformed message serialization or key, routing to dead letter', {
        reason,
      });
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
        payload: canonicalObservation.payload as Record<string, unknown>,
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
   * 1. Validates every supplied copy before any R2 archival, PostgreSQL persistence, or acknowledgement.
   * 2. For valid copies (validation: 'valid'):
   *    - Validates against canonical observation schema (ObservationV2Schema).
   *    - Verifies event_id matches envelope eventId and publication matches authorizedPublicationId.
   *    - Recomputes canonical checksum using canonicalJson and sha256.
   *    - Validates supplied canonicalChecksum matches recomputed checksum.
   *    - Archives valid canonical representation under deterministic conflict key.
   * 3. For invalid copies (validation: 'invalid'):
   *    - Validates bounded metadata against ConflictMetadataSchema.
   *    - Strictly excludes all raw, unvalidated fields from the browser payload.
   *    - Archives safe, schema-approved evidence under deterministic conflict key.
   *    - Never treats invalid copies as accepted observations (no observation_index writes).
   * 4. Preserves create-only semantics on R2 archival.
   * 5. Persists every supported copy into PostgreSQL (app_private.observation_conflict).
   * 6. Strictly follows durability sequence: archive evidence -> persist database -> acknowledge message.
   * 7. Remains idempotent on redelivery.
   */
  private async processConflictMessage(
    envelope: ConflictObservationEnvelope,
    _body: unknown,
  ): Promise<MessageDisposition> {
    const { tenantId, eventId, firstReceivedAt } = envelope;

    // Phase 1: Validate EVERY copy upfront before any R2 archival or DB persistence
    interface ValidatedConflictCopy {
      readonly canonicalEvent?: Record<string, unknown>;
      readonly bytes: Uint8Array;
      readonly checksum: string;
      readonly archiveKey: string;
      readonly isInvalidCopy?: boolean;
    }
    const validatedCopies: ValidatedConflictCopy[] = [];

    for (const copy of envelope.copies) {
      if (copy.validation === 'valid') {
        if (!copy.event) {
          this.log('error', 'Valid conflict copy missing event object', {
            category: 'conflict_integrity_failure',
            reason: 'missing_event',
          });
          return {
            status: 'dead_letter',
            reason: 'Valid conflict copy missing event object',
          };
        }

        const parseResult = ObservationV2Schema.safeParse(copy.event);
        if (!parseResult.success) {
          this.log('error', 'Conflict copy failed canonical observation schema check', {
            category: 'conflict_integrity_failure',
            reason: 'schema_validation_failed',
          });
          return {
            status: 'dead_letter',
            reason: 'Conflict copy failed canonical observation schema check',
          };
        }

        const canonicalEvent = parseResult.data;

        if (canonicalEvent.event_id !== envelope.eventId) {
          this.log('error', 'Conflict copy event_id does not match envelope eventId', {
            category: 'conflict_integrity_failure',
            reason: 'event_id_mismatch',
          });
          return {
            status: 'dead_letter',
            reason: 'Conflict copy event_id does not match top-level envelope eventId',
          };
        }

        if (canonicalEvent.publication_revision_id !== envelope.authorizedPublicationId) {
          this.log('error', 'Conflict copy publication_revision_id does not match envelope', {
            category: 'conflict_integrity_failure',
            reason: 'publication_id_mismatch',
          });
          return {
            status: 'dead_letter',
            reason: 'Conflict copy publication_revision_id does not match top-level envelope',
          };
        }

        const computedChecksum = await sha256(canonicalJson(canonicalEvent));
        if (copy.canonicalChecksum !== computedChecksum) {
          this.log('error', 'Conflict copy canonicalChecksum does not match recomputed checksum', {
            category: 'conflict_integrity_failure',
            reason: 'checksum_mismatch',
          });
          return {
            status: 'dead_letter',
            reason: 'Conflict copy canonicalChecksum does not match recomputed checksum',
          };
        }

        let copyArchiveKey: string;
        try {
          copyArchiveKey = buildConflictArchiveKey(
            tenantId,
            eventId,
            canonicalEvent.occurred_at,
            computedChecksum,
          );
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : 'Invalid conflict archive key';
          this.log('error', 'Malformed conflict archive key, routing to dead letter', {
            category: 'conflict_integrity_failure',
            reason: 'invalid_key',
          });
          return { status: 'dead_letter', reason };
        }

        validatedCopies.push({
          canonicalEvent: canonicalEvent as unknown as Record<string, unknown>,
          bytes: new TextEncoder().encode(JSON.stringify(canonicalEvent)),
          checksum: computedChecksum,
          archiveKey: copyArchiveKey,
        });
      } else if (copy.validation === 'invalid') {
        const metadataResult = ConflictMetadataSchema.safeParse(copy.metadata);
        if (!metadataResult.success) {
          this.log('error', 'Invalid conflict copy metadata failed schema validation', {
            category: 'conflict_integrity_failure',
            reason: 'metadata_validation_failed',
          });
          return {
            status: 'dead_letter',
            reason: 'Invalid conflict copy metadata failed schema validation',
          };
        }

        const validChecksum =
          typeof copy.canonicalChecksum === 'string' &&
          /^[0-9a-f]{64}$/i.test(copy.canonicalChecksum);
        if (!validChecksum) {
          this.log('error', 'Invalid conflict copy canonicalChecksum malformed', {
            category: 'conflict_integrity_failure',
            reason: 'malformed_checksum',
          });
          return {
            status: 'dead_letter',
            reason: 'Invalid conflict copy canonicalChecksum must be a 64-character hex string',
          };
        }

        const checksum = copy.canonicalChecksum.toLowerCase();

        let copyArchiveKey: string;
        try {
          copyArchiveKey = buildConflictArchiveKey(tenantId, eventId, checksum);
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : 'Invalid conflict archive key';
          this.log('error', 'Malformed conflict archive key, routing to dead letter', {
            category: 'conflict_integrity_failure',
            reason: 'invalid_key',
          });
          return { status: 'dead_letter', reason };
        }

        // Quarantine evidence contains strictly bounded, schema-approved metadata
        // and provenance identity. Excludes all raw, unvalidated fields from the durable payload.
        const safeQuarantinePayload = {
          validation: 'invalid' as const,
          tenantId,
          eventId,
          authorizedPublicationId: envelope.authorizedPublicationId,
          canonicalChecksum: checksum,
          metadata: metadataResult.data,
        };

        validatedCopies.push({
          bytes: new TextEncoder().encode(JSON.stringify(safeQuarantinePayload)),
          checksum,
          archiveKey: copyArchiveKey,
          isInvalidCopy: true,
        });
      } else {
        this.log('error', 'Unsupported conflict copy validation variant', {
          category: 'conflict_integrity_failure',
          reason: 'unsupported_validation_variant',
        });
        return {
          status: 'dead_letter',
          reason: 'Conflict copy must have validation of valid or invalid',
        };
      }
    }

    // Phase 2: Now that ALL copies are validated, archive to R2 and persist to DB
    let anyNewRecorded = false;
    for (const copy of validatedCopies) {
      // 1. Archive copy to R2 first (Create-only)
      try {
        this.trace('r2.put', { copyArchiveKey: copy.archiveKey, checksum: copy.checksum });
        const r2Result = await this.deps.r2Storage.putRawPayload(
          copy.archiveKey,
          copy.bytes,
          copy.checksum,
        );
        if (r2Result.status === 'already_exists') {
          if (r2Result.existingChecksum && r2Result.existingChecksum !== copy.checksum) {
            this.log('error', 'R2 conflict archive key exists with conflicting checksum', {
              copyArchiveKey: copy.archiveKey,
              existingChecksum: r2Result.existingChecksum,
              incomingChecksum: copy.checksum,
            });
            return {
              status: 'retry',
              error: new Error(
                `R2 conflict archive key ${copy.archiveKey} already exists with conflicting checksum`,
              ),
            };
          }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log('error', 'R2 conflict copy archive write failed, triggering retry', {
          category: 'storage_failure',
          error: error.message,
        });
        return { status: 'retry', error };
      }

      // 2. Persist in PostgreSQL (app_private.observation_conflict)
      try {
        this.trace('db.recordConflict', { tenantId, eventId, checksum: copy.checksum });
        const outcome = await this.deps.repository.recordConflict({
          tenantId,
          eventId,
          incomingChecksum: copy.checksum,
          r2ArchiveKey: copy.archiveKey,
          receivedAt: firstReceivedAt,
        });
        if (!outcome.alreadyRecorded) anyNewRecorded = true;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log('error', 'Conflict copy DB persistence failed, triggering retry', {
          category: 'database_failure',
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

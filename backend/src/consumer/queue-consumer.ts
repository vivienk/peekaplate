import { canonicalizeJson, sha256Hex } from './canonical-json';
import {
  ALLOWED_EVENT_TYPES,
  type AllowedEventType,
  buildConflictArchiveKey,
  buildRawArchiveKey,
  type ObservationEnvelope,
  type ObservationRepository,
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Validates and extracts the observation envelope from a Queue message body.
 * Adheres strictly to ADR 0015 & PR #32:
 * - Transport identity is (tenant_id, event_id), where tenant_id is the server-derived venue_id.
 * - authorized_publication_id is the server-derived UUID required for provenance.
 * - schema_version must be 'observation.v2' (string).
 * - type must be an allowed P0 event type.
 * - session_id is preserved for downstream fact flows.
 */
export function validateObservationEnvelope(body: unknown): ObservationEnvelope {
  if (!body || typeof body !== 'object') {
    throw new MalformedMessageError('Message body must be an object');
  }

  const b = body as Record<string, unknown>;

  const tenantId = (b.tenantId ?? b.tenant_id ?? b.venueId ?? b.venue_id) as string;
  const eventId = (b.eventId ?? b.event_id) as string;
  const authorizedPublicationId = (b.authorizedPublicationId ??
    b.authorized_publication_id) as string;
  const sessionId = (b.sessionId ?? b.session_id) as string | undefined;
  const schemaVersion = (b.schemaVersion ?? b.schema_version) as string;
  const occurredAt = (b.occurredAt ?? b.occurred_at) as string;
  const type = (b.type ?? b.eventType ?? b.event_type) as string;
  const firstReceivedAt = (b.firstReceivedAt ??
    b.first_received_at ??
    b.receivedAt ??
    b.received_at ??
    new Date().toISOString()) as string;

  if (typeof tenantId !== 'string' || !UUID_REGEX.test(tenantId)) {
    throw new MalformedMessageError('Missing or invalid tenantId: must be a valid UUID');
  }
  if (typeof eventId !== 'string' || !UUID_REGEX.test(eventId)) {
    throw new MalformedMessageError('Missing or invalid eventId: must be a valid UUID');
  }
  if (typeof authorizedPublicationId !== 'string' || !UUID_REGEX.test(authorizedPublicationId)) {
    throw new MalformedMessageError(
      'Missing or invalid authorizedPublicationId: must be a valid UUID',
    );
  }
  if (schemaVersion !== 'observation.v2') {
    throw new MalformedMessageError(
      `Unsupported schemaVersion: expected 'observation.v2', got ${JSON.stringify(schemaVersion)}`,
    );
  }
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    throw new MalformedMessageError('Missing or invalid occurredAt timestamp');
  }
  if (typeof firstReceivedAt !== 'string' || Number.isNaN(Date.parse(firstReceivedAt))) {
    throw new MalformedMessageError('Missing or invalid firstReceivedAt timestamp');
  }
  if (typeof type !== 'string' || !ALLOWED_EVENT_TYPES.includes(type as AllowedEventType)) {
    throw new MalformedMessageError(`Unsupported observation type: ${type}`);
  }

  const payload = (b.payload && typeof b.payload === 'object' ? b.payload : b) as Record<
    string,
    unknown
  >;

  return {
    tenantId,
    venueId: tenantId,
    eventId,
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
    schemaVersion: 'observation.v2',
    occurredAt,
    type,
    authorizedPublicationId,
    payload,
    firstReceivedAt,
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
   * 1. Validate envelope.
   * 2. Canonicalize payload and compute deterministic SHA-256 checksum.
   * 3. Archive raw payload to R2 first using create-only semantics.
   *    (If a conflicting payload is detected, archive under a distinct conflict key).
   * 4. Persist canonical observation in Postgres (idempotently with forced RLS).
   * 5. Handle duplicate or conflict outcomes without rewriting original records.
   * 6. Return appropriate disposition.
   */
  async processMessage(body: unknown): Promise<MessageDisposition> {
    // Step 1: Validate envelope
    let envelope: ObservationEnvelope;
    try {
      envelope = validateObservationEnvelope(body);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'Unknown validation error';
      this.log('error', 'Malformed message received, routing to dead letter', { reason });
      return { status: 'dead_letter', reason };
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
        // either ack() after terminal logging or exhaust retries into the DLQ.
        // We acknowledge the malformed message so it does not cycle endlessly,
        // having recorded the terminal disposition.
        this.trace('msg.dead_letter', { id: msg.id });
        msg.ack();
        acknowledged++;
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

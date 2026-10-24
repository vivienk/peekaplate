import { canonicalizeJson, sha256Hex } from './canonical-json';
import {
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
 * Adheres strictly to ADR 0015:
 * Transport identity is (venue_id, event_id).
 * venue_id is set/verified by server during ingest.
 */
export function validateObservationEnvelope(body: unknown): ObservationEnvelope {
  if (!body || typeof body !== 'object') {
    throw new MalformedMessageError('Message body must be an object');
  }

  const b = body as Record<string, unknown>;

  // Check required fields
  const venueId = b.venueId ?? b.venue_id;
  const eventId = b.eventId ?? b.event_id;
  const sessionId = b.sessionId ?? b.session_id;
  const schemaVersion = b.schemaVersion ?? b.schema_version ?? 2;
  const occurredAt = b.occurredAt ?? b.occurred_at;
  const type = b.type ?? b.eventType ?? b.event_type;

  if (typeof venueId !== 'string' || !venueId) {
    throw new MalformedMessageError('Missing or invalid venueId');
  }
  if (typeof eventId !== 'string' || !eventId) {
    throw new MalformedMessageError('Missing or invalid eventId');
  }
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    throw new MalformedMessageError('Missing or invalid occurredAt timestamp');
  }
  if (typeof type !== 'string' || !type) {
    throw new MalformedMessageError('Missing or invalid observation type');
  }

  const payload = (b.payload && typeof b.payload === 'object' ? b.payload : b) as Record<
    string,
    unknown
  >;

  return {
    venueId,
    eventId,
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
    schemaVersion: Number(schemaVersion),
    occurredAt,
    type,
    payload,
    receivedAt: (b.receivedAt ?? b.received_at ?? new Date().toISOString()) as string,
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
   * 4. Persist canonical observation in Postgres (idempotently).
   * 5. Handle duplicate or conflict outcomes.
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

    const { venueId, eventId, sessionId, occurredAt, schemaVersion, type, payload, receivedAt } =
      envelope;

    // Step 2: Canonicalize and hash content
    const canonicalStr = canonicalizeJson(payload);
    const checksum = await sha256Hex(canonicalStr);

    // Raw bytes of the payload for R2 archival (preserves raw incoming structure)
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
      archiveKey = buildRawArchiveKey(venueId, eventId, occurredAt);
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

        // If existing archive has a DIFFERENT checksum, this is an archive conflict!
        if (r2Result.existingChecksum && r2Result.existingChecksum !== checksum) {
          this.log('warn', 'R2 archive checksum discrepancy detected - quarantining as conflict', {
            venueId,
            eventId,
            incomingChecksum: checksum,
            existingChecksum: r2Result.existingChecksum,
          });

          this.trace('db.recordConflict', { venueId, eventId });
          await this.deps.repository.recordConflict({
            venueId,
            eventId,
            schemaVersion,
            type,
            occurredAt,
            receivedAt: receivedAt ?? new Date().toISOString(),
            incomingChecksum: checksum,
            originalChecksum: r2Result.existingChecksum,
            incomingR2ArchiveKey: archiveKey,
            incomingPayload: payload,
          });

          return { status: 'acknowledged', reason: 'conflict_recorded' };
        }
      }
    } catch (err: unknown) {
      // Transient R2 failure -> retry message
      const error = err instanceof Error ? err : new Error(String(err));
      this.log('error', 'R2 raw archive write failed, triggering retry', {
        venueId,
        eventId,
        error: error.message,
      });
      return { status: 'retry', error };
    }

    // Step 4 & 5: Persist canonical observation in database
    try {
      this.trace('db.persistCanonical', { venueId, eventId });
      const outcome = await this.deps.repository.persistCanonical({
        venueId,
        eventId,
        sessionId,
        schemaVersion,
        type,
        occurredAt,
        receivedAt: receivedAt ?? new Date().toISOString(),
        checksum,
        r2ArchiveKey: archiveKey,
        payload,
      });

      if (outcome.disposition === 'accepted') {
        this.log('info', 'Canonical observation accepted and persisted', { venueId, eventId });
        return { status: 'acknowledged', reason: 'persisted' };
      }

      if (outcome.disposition === 'duplicate') {
        this.log('info', 'Duplicate observation received with identical payload', {
          venueId,
          eventId,
        });
        return { status: 'acknowledged', reason: 'duplicate_same_payload' };
      }

      if (outcome.disposition === 'conflict') {
        this.log('warn', 'Event identity conflict detected - recording in conflict table', {
          venueId,
          eventId,
          conflictReason: outcome.conflictReason,
        });

        // Fetch original checksum for conflict log
        const existing = await this.deps.repository.lookupExisting(venueId, eventId);
        this.trace('db.recordConflict', { venueId, eventId });
        await this.deps.repository.recordConflict({
          venueId,
          eventId,
          schemaVersion,
          type,
          occurredAt,
          receivedAt: receivedAt ?? new Date().toISOString(),
          incomingChecksum: checksum,
          originalChecksum: existing?.checksum ?? 'unknown',
          incomingR2ArchiveKey: archiveKey,
          incomingPayload: payload,
        });

        return { status: 'acknowledged', reason: 'conflict_recorded' };
      }

      return { status: 'acknowledged', reason: 'persisted' };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log('error', 'Database persistence failed, triggering retry', {
        venueId,
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

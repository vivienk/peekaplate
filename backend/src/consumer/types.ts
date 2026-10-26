import {
  type ObservationConflictQueueMessage,
  type ObservationConflictV1QueueEnvelope,
  type ObservationQueueEnvelope,
  type ObservationQueueMessage,
  ObservationTypeSchema,
  type ObservationV2QueueEnvelope,
} from '@peekaplate/contracts';

/**
 * Contracts and domain types for the Cloudflare Queue Consumer (S3-DATA-02).
 *
 * Conforms to ADR 0015, the DATA-01 -> DATA-02 mapping v0.2, and the canonical
 * PostgreSQL schema defined in PR #32 (app_private.observation_index and
 * app_private.observation_conflict).
 */

export const ALLOWED_EVENT_TYPES = ObservationTypeSchema.options;

export type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

export const REJECTION_REASON_CODES = [
  'schema_invalid',
  'unknown_type',
  'too_old',
  'future_time',
  'publication_not_allowed',
] as const;

export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

export type EventIdentity = {
  tenantId: string;
  eventId: string;
};

/**
 * Normal observation envelope extracted from Queue message.
 * Adheres strictly to the canonical shared schema ObservationQueueMessageSchema.
 */
export type NormalObservationEnvelope = ObservationQueueMessage & {
  venueId?: string | undefined; // alias for backwards compatibility
};

/**
 * Backwards-compatible alias for NormalObservationEnvelope.
 */
export type ObservationEnvelope = NormalObservationEnvelope;

/**
 * Conflict observation envelope extracted from Queue message (ADR 0015 / PR #40).
 * Sent by the producer when a conflicting observation reuse is detected at ingestion.
 * Carries either a full conflicting payload copy or bounded metadata for invalid copies.
 */
export type ConflictObservationEnvelope = ObservationConflictQueueMessage & {
  venueId?: string | undefined;
};

/**
 * Supported Queue Envelope union variants (ADR 0015 / PR #40).
 */
export type QueueObservationEnvelope = ObservationQueueEnvelope & {
  venueId?: string | undefined;
};

/**
 * Result of R2 create-only put operation.
 */
export type R2PutResult =
  | { status: 'created'; key: string }
  | { status: 'already_exists'; key: string; existingChecksum?: string | undefined };

/**
 * Port interface for R2 storage operations.
 */
export interface R2ArchiveStorage {
  /**
   * Puts raw payload under key using create-only semantics (must not overwrite).
   * If key already exists, returns status: 'already_exists' along with existing checksum if known.
   */
  putRawPayload(key: string, rawBytes: Uint8Array, checksum: string): Promise<R2PutResult>;

  /**
   * Reads raw payload object and its stored checksum from R2 if present.
   */
  getRawPayload(key: string): Promise<{ rawBytes: Uint8Array; checksum: string } | null>;
}

/**
 * Persistence disposition outcome.
 */
export type PersistenceOutcome =
  | { disposition: 'accepted'; isDuplicate: false; reasonCode?: undefined }
  | { disposition: 'rejected'; isDuplicate: false; reasonCode: string }
  | { disposition: 'duplicate'; isDuplicate: true; reasonCode?: undefined }
  | { disposition: 'conflict'; conflictReason: string; originalChecksum?: string };

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

/**
 * Port interface for observation database persistence.
 * Matches ADR 0015 canonical tables from PR #32:
 * - app_private.observation_index: (tenant_id, event_id) PRIMARY KEY
 * - app_private.observation_conflict: (tenant_id, event_id, incoming_checksum) PRIMARY KEY
 */
export interface ObservationRepository {
  /**
   * Checks whether the event identity (tenant_id, event_id) already exists.
   * If it exists, returns its stored payload checksum and disposition.
   */
  lookupExisting(
    tenantId: string,
    eventId: string,
  ): Promise<{ checksum: string; disposition: string } | null>;

  /**
   * Records a canonical observation index.
   * Runs in an atomic transaction with forced tenant RLS (app.tenant_id).
   * If a unique constraint violation occurs concurrently on (tenant_id, event_id),
   * returns duplicate or conflict outcome based on checksum comparison.
   */
  persistCanonical(record: {
    tenantId: string;
    eventId: string;
    sessionId?: string | undefined;
    schemaVersion: 'observation.v2';
    eventType: string;
    authorizedPublicationId: string;
    occurredAt: string;
    firstReceivedAt: string;
    checksum: string;
    r2ArchiveKey: string;
    payload: Record<string, unknown>;
    factData?: Record<string, unknown> | undefined;
  }): Promise<PersistenceOutcome>;

  /**
   * Records a conflict into app_private.observation_conflict table
   * without overwriting original canonical event.
   * Returns whether this conflict was already recorded (idempotent redelivery).
   */
  recordConflict(conflict: {
    tenantId: string;
    eventId: string;
    incomingChecksum: string;
    r2ArchiveKey: string;
    receivedAt: string;
  }): Promise<{ alreadyRecorded: boolean }>;
}

/**
 * Formats R2 archive key following ADR 0015 and repository conventions.
 * Format: raw/observations/{tenant_id}/{yyyy}/{mm}/{dd}/{event_id}.json
 * Sanitizes and validates inputs to prevent path traversal or invalid keys.
 */
export function buildRawArchiveKey(
  tenantId: string,
  eventId: string,
  occurredAtIso: string,
): string {
  if (!tenantId || tenantId.includes('/') || tenantId.includes('\\') || tenantId.includes('..')) {
    throw new InvalidKeyError(`Invalid tenantId for archive key: ${tenantId}`);
  }
  if (!eventId || eventId.includes('/') || eventId.includes('\\') || eventId.includes('..')) {
    throw new InvalidKeyError(`Invalid eventId for archive key: ${eventId}`);
  }

  const date = new Date(occurredAtIso);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidKeyError(`Invalid occurredAt date for archive key: ${occurredAtIso}`);
  }

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `raw/observations/${tenantId}/${yyyy}/${mm}/${dd}/${eventId}.json`;
}

/**
 * Formats R2 conflict archive key ensuring distinct payloads reusing the same
 * (tenant_id, event_id) get unique, deterministic, path-traversal-safe keys.
 * Format: raw/observations/{tenant_id}/{yyyy}/{mm}/{dd}/{event_id}-{incoming_checksum}.json
 */
export function buildConflictArchiveKey(
  tenantId: string,
  eventId: string,
  occurredAtIso: string,
  incomingChecksum: string,
): string {
  if (!tenantId || tenantId.includes('/') || tenantId.includes('\\') || tenantId.includes('..')) {
    throw new InvalidKeyError(`Invalid tenantId for conflict archive key: ${tenantId}`);
  }
  if (!eventId || eventId.includes('/') || eventId.includes('\\') || eventId.includes('..')) {
    throw new InvalidKeyError(`Invalid eventId for conflict archive key: ${eventId}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(incomingChecksum)) {
    throw new InvalidKeyError(`Invalid checksum for conflict archive key: ${incomingChecksum}`);
  }

  const date = new Date(occurredAtIso);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidKeyError(`Invalid occurredAt date for conflict archive key: ${occurredAtIso}`);
  }

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `raw/observations/${tenantId}/${yyyy}/${mm}/${dd}/${eventId}-${incomingChecksum.toLowerCase()}.json`;
}

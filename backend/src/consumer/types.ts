/**
 * Provisional contracts and domain types for the Queue Consumer.
 *
 * NOTE: The production message contract is owned by Zhiliang (S3-DIN-02),
 * and the production database tables/migrations are owned by Jeffin (S3-DATA-01).
 *
 * These types and interfaces are PROVISIONAL and TEST-ONLY adapters that match
 * the boundaries agreed in ADR 0015 and will be replaced by confirmed schemas.
 */

export type EventIdentity = {
  venueId: string;
  eventId: string;
};

/**
 * Validated observation item extracted from Queue message.
 * ADR 0015 defines:
 * transport key is (venue_id, event_id).
 * venue_id derived on the server from signed menu token at ingest.
 * schema_version is 2 for observation.v2.
 */
export type ObservationEnvelope = {
  venueId: string;
  eventId: string;
  sessionId?: string | undefined;
  schemaVersion: number;
  occurredAt: string;
  type: string;
  payload: Record<string, unknown>;
  receivedAt?: string | undefined;
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
  | { disposition: 'accepted'; isDuplicate: false }
  | { disposition: 'duplicate'; isDuplicate: true }
  | { disposition: 'conflict'; conflictReason: string };

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

/**
 * Port interface for observation database persistence.
 * Matches ADR 0015 canonical tables:
 * - app_private.observation_index
 * - app_private.observation_conflict
 * - app_private.observation_<type>_fact (typed facts)
 */
export interface ObservationRepository {
  /**
   * Checks whether the event identity (venue_id, event_id) already exists.
   * If it exists, returns its stored payload checksum.
   */
  lookupExisting(
    venueId: string,
    eventId: string,
  ): Promise<{ checksum: string; disposition: string } | null>;

  /**
   * Records a canonical observation index and typed fact atomically.
   * If a unique constraint violation occurs concurrently on (venue_id, event_id),
   * returns duplicate or conflict outcome based on checksum comparison.
   */
  persistCanonical(record: {
    venueId: string;
    eventId: string;
    sessionId?: string | undefined;
    schemaVersion: number;
    type: string;
    occurredAt: string;
    receivedAt: string;
    checksum: string;
    r2ArchiveKey: string;
    payload: Record<string, unknown>;
    factData?: Record<string, unknown> | undefined;
  }): Promise<PersistenceOutcome>;

  /**
   * Records a conflict into app_private.observation_conflict table
   * without overwriting original canonical event.
   */
  recordConflict(conflict: {
    venueId: string;
    eventId: string;
    schemaVersion: number;
    type: string;
    occurredAt: string;
    receivedAt: string;
    incomingChecksum: string;
    originalChecksum: string;
    incomingR2ArchiveKey: string;
    incomingPayload: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Formats R2 archive key following ADR 0015 and repository conventions.
 * Format: raw/observations/{venue_id}/{yyyy}/{mm}/{dd}/{event_id}.json
 * Sanitizes and validates inputs to prevent path traversal or invalid keys.
 */
export function buildRawArchiveKey(
  venueId: string,
  eventId: string,
  occurredAtIso: string,
): string {
  if (!venueId || venueId.includes('/') || venueId.includes('\\') || venueId.includes('..')) {
    throw new InvalidKeyError(`Invalid venueId for archive key: ${venueId}`);
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
  return `raw/observations/${venueId}/${yyyy}/${mm}/${dd}/${eventId}.json`;
}

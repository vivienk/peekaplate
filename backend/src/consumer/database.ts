import type { Client } from 'pg';
import type { ObservationRepository, PersistenceOutcome } from './types';

/**
 * Microsecond constants for observation ingest time window.
 */
export const TWENTY_FOUR_HOURS_MICROS = 24n * 60n * 60n * 1000n * 1000n; // 86_400_000_000n µs
export const FIVE_MINUTES_MICROS = 5n * 60n * 1000n * 1000n; // 300_000_000n µs

/**
 * Parses an ISO-8601 timestamp with optional timezone offset and fractional seconds
 * into exact integer microseconds (BigInt) since the Unix epoch (1970-01-01T00:00:00.000000Z).
 * Correctly preserves fractional seconds up to microsecond precision, matching
 * PostgreSQL's timestamptz microsecond representation.
 */
export function parseIsoToMicroseconds(isoString: string): bigint {
  const trimmed = isoString.trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i.exec(
      trimmed,
    );
  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined ||
    match[5] === undefined ||
    match[6] === undefined
  ) {
    const fallbackMs = Date.parse(trimmed);
    if (Number.isNaN(fallbackMs)) {
      throw new Error(`Invalid ISO timestamp: ${isoString}`);
    }
    return BigInt(fallbackMs) * 1000n;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const min = parseInt(match[5], 10);
  const sec = parseInt(match[6], 10);
  const fractionStr = match[7] ?? '';
  const tzSign = match[9];
  const tzHourStr = match[10];
  const tzMinStr = match[11];

  let utcMs = Date.UTC(year, month, day, hour, min, sec);

  if (tzSign && tzHourStr && tzMinStr) {
    const offsetMinutes = parseInt(tzHourStr, 10) * 60 + parseInt(tzMinStr, 10);
    if (tzSign === '+') {
      utcMs -= offsetMinutes * 60 * 1000;
    } else {
      utcMs += offsetMinutes * 60 * 1000;
    }
  }

  let totalMicros = BigInt(utcMs) * 1000n;

  if (fractionStr.length > 0) {
    if (fractionStr.length <= 6) {
      totalMicros += BigInt(fractionStr.padEnd(6, '0'));
    } else {
      // PostgreSQL timestamptz parses fractional seconds to microsecond precision
      // using round-to-nearest, ties-to-even (banker's rounding).
      let micros = BigInt(fractionStr.slice(0, 6));
      const seventhChar = fractionStr[6];
      if (seventhChar !== undefined) {
        if (seventhChar > '5') {
          micros += 1n;
        } else if (seventhChar === '5') {
          // Check if there are any non-zero digits after the 7th character (e.g. .00000051)
          const hasNonZeroAfter = fractionStr
            .slice(7)
            .split('')
            .some((c) => c !== '0');
          if (hasNonZeroAfter) {
            micros += 1n;
          } else {
            // Exact tie (.5 µs): round to nearest EVEN microsecond
            if (micros % 2n !== 0n) {
              micros += 1n;
            }
          }
        }
      }
      totalMicros += micros;
    }
  }

  return totalMicros;
}

/**
 * Classifies an observation's time window per ADR 0015 & PR #32:
 * Lower bound: first_received_at - 24 hours (inclusive)
 * Upper bound: first_received_at + 5 minutes (inclusive)
 *
 * Distinguishes boundary cases with microsecond precision to remain
 * 100% consistent with PostgreSQL's timestamptz CHECK constraint.
 */
export function classifyObservationTimeWindow(
  occurredAtIso: string,
  firstReceivedAtIso: string,
): { disposition: 'accepted' | 'rejected'; reasonCode?: 'too_old' | 'future_time' } {
  const occurredMicros = parseIsoToMicroseconds(occurredAtIso);
  const receivedMicros = parseIsoToMicroseconds(firstReceivedAtIso);
  const diffMicros = occurredMicros - receivedMicros;

  if (diffMicros < -TWENTY_FOUR_HOURS_MICROS) {
    return { disposition: 'rejected', reasonCode: 'too_old' };
  }
  if (diffMicros > FIVE_MINUTES_MICROS) {
    return { disposition: 'rejected', reasonCode: 'future_time' };
  }
  return { disposition: 'accepted' };
}

/**
 * PostgreSQL implementation of ObservationRepository.
 * Uses atomic transactions, statement timeouts, pg_advisory_xact_lock concurrency serialization,
 * and forced tenant RLS (app.tenant_id) to enforce tenant isolation and canonical uniqueness.
 *
 * Conforms to ADR 0015 and PR #32:
 * - app_private.observation_index: (tenant_id, event_id) PRIMARY KEY, append-only
 * - app_private.observation_conflict: (tenant_id, event_id, incoming_checksum) PRIMARY KEY, append-only
 */
export class PostgresObservationRepository implements ObservationRepository {
  constructor(private readonly client: Client) {}

  async lookupExisting(
    tenantId: string,
    eventId: string,
  ): Promise<{ checksum: string; disposition: string } | null> {
    let started = false;
    try {
      await this.client.query('BEGIN');
      started = true;
      await this.client.query("SET LOCAL statement_timeout = '5s'");
      await this.client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

      const res = await this.client.query<{ checksum: string; disposition: string }>(
        `SELECT canonical_payload_checksum AS checksum, disposition
         FROM app_private.observation_index
         WHERE tenant_id = $1 AND event_id = $2`,
        [tenantId, eventId],
      );

      await this.client.query('COMMIT');
      started = false;
      return res.rows[0] ?? null;
    } catch (err: unknown) {
      if (started) {
        try {
          await this.client.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
      }
      throw err;
    }
  }

  async persistCanonical(record: {
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
  }): Promise<PersistenceOutcome> {
    let started = false;
    try {
      await this.client.query('BEGIN');
      started = true;
      await this.client.query("SET LOCAL statement_timeout = '5s'");

      // Set tenant context inside transaction before any read/write (forced RLS)
      await this.client.query("SELECT set_config('app.tenant_id', $1, true)", [record.tenantId]);

      // Advisory transaction lock prevents concurrent deliveries from racing on insert
      await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `observation:${record.tenantId}:${record.eventId}`,
      ]);

      // Check existing under advisory lock / isolation
      const existing = await this.client.query<{ checksum: string; disposition: string }>(
        `SELECT canonical_payload_checksum AS checksum, disposition
         FROM app_private.observation_index
         WHERE tenant_id = $1 AND event_id = $2`,
        [record.tenantId, record.eventId],
      );

      if (existing.rows.length > 0) {
        const stored = existing.rows[0]!;
        await this.client.query('COMMIT');
        started = false;

        if (stored.checksum === record.checksum) {
          return { disposition: 'duplicate', isDuplicate: true };
        }
        return {
          disposition: 'conflict',
          conflictReason: `Payload checksum ${record.checksum} differs from canonical ${stored.checksum}`,
          originalChecksum: stored.checksum,
        };
      }

      // Time window check as defined in ADR 0015 and PR #32:
      // first_received_at - 24 hours <= occurred_at <= first_received_at + 5 minutes
      // Evaluated using PostgreSQL's authoritative timestamptz comparison, guaranteeing
      // 100% agreement with the table's CHECK constraint.
      const timeCheck = await this.client.query<{ reason_code: 'too_old' | 'future_time' | null }>(
        `SELECT
           CASE
             WHEN $1::timestamptz < $2::timestamptz - interval '24 hours' THEN 'too_old'
             WHEN $1::timestamptz > $2::timestamptz + interval '5 minutes' THEN 'future_time'
             ELSE NULL
           END AS reason_code`,
        [record.occurredAt, record.firstReceivedAt],
      );
      const reasonCode = timeCheck.rows[0]?.reason_code ?? null;
      const disposition = reasonCode !== null ? 'rejected' : 'accepted';

      // Insert canonical index row (append-only: no UPDATE or DELETE)
      await this.client.query(
        `INSERT INTO app_private.observation_index
          (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type,
           authorized_publication_id, occurred_at, first_received_at, r2_archive_key,
           disposition, reason_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.tenantId,
          record.eventId,
          record.checksum,
          record.schemaVersion,
          record.eventType,
          record.authorizedPublicationId,
          record.occurredAt,
          record.firstReceivedAt,
          record.r2ArchiveKey,
          disposition,
          reasonCode,
        ],
      );

      // Typed fact persistence boundary: PR #31 writes the canonical index row (app_private.observation_index)
      // and conflict records (app_private.observation_conflict) matching PR #32.
      // Typed fact table persistence (app_private.observation_event and typed fact tables)
      // belongs to follow-up work once PR #50's migration merges into develop and the producer
      // contract provides server-derived traffic_class. The raw payload is fully preserved in R2.
      if (record.factData) {
        // Reserved for future PR #50 typed facts integration
      }

      await this.client.query('COMMIT');
      started = false;

      if (disposition === 'rejected') {
        return { disposition: 'rejected', isDuplicate: false, reasonCode: reasonCode! };
      }
      return { disposition: 'accepted', isDuplicate: false };
    } catch (err: unknown) {
      if (started) {
        try {
          await this.client.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
      }

      // Duplicate key violation (code 23505) fallback on concurrent race
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        const check = await this.lookupExisting(record.tenantId, record.eventId);
        if (!check) {
          // Concurrent transaction may have rolled back; re-throw so queue retries
          throw err;
        }
        if (check.checksum === record.checksum) {
          return { disposition: 'duplicate', isDuplicate: true };
        }
        return {
          disposition: 'conflict',
          conflictReason: 'Concurrent duplicate key with differing checksum',
          originalChecksum: check.checksum,
        };
      }
      throw err;
    }
  }

  async recordConflict(conflict: {
    tenantId: string;
    eventId: string;
    incomingChecksum: string;
    r2ArchiveKey: string;
    receivedAt: string;
  }): Promise<{ alreadyRecorded: boolean }> {
    let started = false;
    try {
      await this.client.query('BEGIN');
      started = true;
      await this.client.query("SET LOCAL statement_timeout = '5s'");

      // Set tenant context inside transaction before write
      await this.client.query("SELECT set_config('app.tenant_id', $1, true)", [conflict.tenantId]);

      // Advisory lock for conflict recording
      await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `conflict:${conflict.tenantId}:${conflict.eventId}:${conflict.incomingChecksum}`,
      ]);

      const res = await this.client.query(
        `INSERT INTO app_private.observation_conflict
          (tenant_id, event_id, incoming_checksum, r2_archive_key, received_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, event_id, incoming_checksum) DO NOTHING
         RETURNING 1`,
        [
          conflict.tenantId,
          conflict.eventId,
          conflict.incomingChecksum,
          conflict.r2ArchiveKey,
          conflict.receivedAt,
        ],
      );

      await this.client.query('COMMIT');
      started = false;
      const inserted = (res.rowCount ?? 0) > 0;
      return { alreadyRecorded: !inserted };
    } catch (err: unknown) {
      if (started) {
        try {
          await this.client.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
      }
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return { alreadyRecorded: true };
      }
      throw err;
    }
  }
}

/**
 * In-memory deterministic fake observation repository for fast, reliable unit tests.
 */
export class FakeObservationRepository implements ObservationRepository {
  public index = new Map<
    string,
    {
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
      disposition: 'accepted' | 'rejected';
      reasonCode?: string | undefined;
    }
  >();

  public conflicts = new Map<
    string,
    {
      tenantId: string;
      eventId: string;
      incomingChecksum: string;
      r2ArchiveKey: string;
      receivedAt: string;
    }
  >();

  public failNextPersist = false;
  public failNextRecordConflict = false;
  public failOnEventId?: string;

  private key(tenantId: string, eventId: string): string {
    return `${tenantId}:${eventId}`;
  }

  private conflictKey(tenantId: string, eventId: string, incomingChecksum: string): string {
    return `${tenantId}:${eventId}:${incomingChecksum}`;
  }

  async lookupExisting(
    tenantId: string,
    eventId: string,
  ): Promise<{ checksum: string; disposition: string } | null> {
    const found = this.index.get(this.key(tenantId, eventId));
    if (!found) return null;
    return { checksum: found.checksum, disposition: found.disposition };
  }

  async persistCanonical(record: {
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
  }): Promise<PersistenceOutcome> {
    if (this.failNextPersist || (this.failOnEventId && record.eventId === this.failOnEventId)) {
      this.failNextPersist = false;
      throw new Error('Database transaction timeout / connection failure');
    }

    const k = this.key(record.tenantId, record.eventId);
    const existing = this.index.get(k);

    if (existing) {
      if (existing.checksum === record.checksum) {
        return { disposition: 'duplicate', isDuplicate: true };
      }
      return {
        disposition: 'conflict',
        conflictReason: `Incoming checksum ${record.checksum} != original ${existing.checksum}`,
        originalChecksum: existing.checksum,
      };
    }

    const timeClassification = classifyObservationTimeWindow(
      record.occurredAt,
      record.firstReceivedAt,
    );
    const disposition = timeClassification.disposition;
    const reasonCode = timeClassification.reasonCode;

    this.index.set(k, {
      ...record,
      disposition,
      reasonCode,
    });

    if (disposition === 'rejected') {
      return { disposition: 'rejected', isDuplicate: false, reasonCode: reasonCode! };
    }
    return { disposition: 'accepted', isDuplicate: false };
  }

  async recordConflict(conflict: {
    tenantId: string;
    eventId: string;
    incomingChecksum: string;
    r2ArchiveKey: string;
    receivedAt: string;
  }): Promise<{ alreadyRecorded: boolean }> {
    if (this.failNextRecordConflict) {
      this.failNextRecordConflict = false;
      throw new Error('Conflict table insertion failed');
    }

    const ck = this.conflictKey(conflict.tenantId, conflict.eventId, conflict.incomingChecksum);
    if (this.conflicts.has(ck)) {
      return { alreadyRecorded: true };
    }

    this.conflicts.set(ck, { ...conflict });
    return { alreadyRecorded: false };
  }
}

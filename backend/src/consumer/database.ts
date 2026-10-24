import type { Client } from 'pg';
import type { ObservationRepository, PersistenceOutcome } from './types';

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
      const occurredTime = new Date(record.occurredAt).getTime();
      const receivedTime = new Date(record.firstReceivedAt).getTime();
      const diffMs = occurredTime - receivedTime;
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      const fiveMinutesMs = 5 * 60 * 1000;

      let disposition: 'accepted' | 'rejected' = 'accepted';
      let reasonCode: string | null = null;

      if (diffMs < -twentyFourHoursMs) {
        disposition = 'rejected';
        reasonCode = 'too_old';
      } else if (diffMs > fiveMinutesMs) {
        disposition = 'rejected';
        reasonCode = 'future_time';
      }

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

      // Typed fact persistence hook: when Jeffin's typed fact migrations land,
      // facts will be inserted within this same transaction using record.sessionId.
      if (record.factData) {
        // Reserved for future typed facts migration
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

    const occurredTime = new Date(record.occurredAt).getTime();
    const receivedTime = new Date(record.firstReceivedAt).getTime();
    const diffMs = occurredTime - receivedTime;
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    const fiveMinutesMs = 5 * 60 * 1000;

    let disposition: 'accepted' | 'rejected' = 'accepted';
    let reasonCode: string | undefined;

    if (diffMs < -twentyFourHoursMs) {
      disposition = 'rejected';
      reasonCode = 'too_old';
    } else if (diffMs > fiveMinutesMs) {
      disposition = 'rejected';
      reasonCode = 'future_time';
    }

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

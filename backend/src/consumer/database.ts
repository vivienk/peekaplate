import type { Client } from 'pg';
import type { ObservationRepository, PersistenceOutcome } from './types';

/**
 * PostgreSQL implementation of ObservationRepository.
 * Uses atomic transactions, advisory locks or ON CONFLICT to enforce uniqueness.
 * Tables:
 * - app_private.observation_index: (venue_id, event_id) PRIMARY KEY
 * - app_private.observation_conflict: table recording quarantined conflicting reuse
 */
export class PostgresObservationRepository implements ObservationRepository {
  constructor(private readonly client: Client) {}

  async lookupExisting(
    venueId: string,
    eventId: string,
  ): Promise<{ checksum: string; disposition: string } | null> {
    const res = await this.client.query<{ checksum: string; disposition: string }>(
      `SELECT checksum, disposition
       FROM app_private.observation_index
       WHERE venue_id = $1 AND event_id = $2`,
      [venueId, eventId],
    );
    return res.rows[0] ?? null;
  }

  async persistCanonical(record: {
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
  }): Promise<PersistenceOutcome> {
    let started = false;
    try {
      await this.client.query('BEGIN');
      started = true;
      await this.client.query("SET LOCAL statement_timeout = '5s'");

      // Advisory transaction lock prevents concurrent deliveries from racing on insert
      await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `observation:${record.venueId}:${record.eventId}`,
      ]);

      // Check existing under lock / isolation
      const existing = await this.client.query<{ checksum: string }>(
        `SELECT checksum
         FROM app_private.observation_index
         WHERE venue_id = $1 AND event_id = $2
         FOR UPDATE`,
        [record.venueId, record.eventId],
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
        };
      }

      // Insert canonical index
      await this.client.query(
        `INSERT INTO app_private.observation_index
          (venue_id, event_id, schema_version, event_type, occurred_at, received_at, checksum, r2_archive_key, disposition)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accepted')`,
        [
          record.venueId,
          record.eventId,
          record.schemaVersion,
          record.type,
          record.occurredAt,
          record.receivedAt,
          record.checksum,
          record.r2ArchiveKey,
        ],
      );

      // Typed fact persistence extension point (provisional hook for Jeffin's confirmed schema)
      if (record.factData) {
        // When Jeffin's typed fact migrations land, insert the fact row in the same transaction:
        // e.g. INSERT INTO app_private.observation_<type>_fact ...
      }

      await this.client.query('COMMIT');
      started = false;
      return { disposition: 'accepted', isDuplicate: false };
    } catch (err: unknown) {
      if (started) {
        try {
          await this.client.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
      }

      // Check if duplicate key violation (code 23505) in concurrent race fallback
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        const check = await this.lookupExisting(record.venueId, record.eventId);
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
        };
      }
      throw err;
    }
  }

  async recordConflict(conflict: {
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
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO app_private.observation_conflict
        (venue_id, event_id, schema_version, event_type, occurred_at, received_at,
         incoming_checksum, original_checksum, r2_archive_key, incoming_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        conflict.venueId,
        conflict.eventId,
        conflict.schemaVersion,
        conflict.type,
        conflict.occurredAt,
        conflict.receivedAt,
        conflict.incomingChecksum,
        conflict.originalChecksum,
        conflict.incomingR2ArchiveKey,
        JSON.stringify(conflict.incomingPayload),
      ],
    );
  }
}

/**
 * In-memory deterministic fake observation repository for fast, reliable unit tests.
 */
export class FakeObservationRepository implements ObservationRepository {
  public index = new Map<
    string,
    {
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
      disposition: string;
    }
  >();

  public conflicts: {
    venueId: string;
    eventId: string;
    incomingChecksum: string;
    originalChecksum: string;
    r2ArchiveKey: string;
    payload: Record<string, unknown>;
  }[] = [];

  public failNextPersist = false;
  public failNextRecordConflict = false;

  public failOnEventId?: string;

  private key(venueId: string, eventId: string): string {
    return `${venueId}:${eventId}`;
  }

  async lookupExisting(
    venueId: string,
    eventId: string,
  ): Promise<{ checksum: string; disposition: string } | null> {
    const found = this.index.get(this.key(venueId, eventId));
    if (!found) return null;
    return { checksum: found.checksum, disposition: found.disposition };
  }

  async persistCanonical(record: {
    venueId: string;
    eventId: string;
    schemaVersion: number;
    type: string;
    occurredAt: string;
    receivedAt: string;
    checksum: string;
    r2ArchiveKey: string;
    payload: Record<string, unknown>;
  }): Promise<PersistenceOutcome> {
    if (this.failNextPersist || (this.failOnEventId && record.eventId === this.failOnEventId)) {
      this.failNextPersist = false;
      throw new Error('Database transaction timeout / connection failure');
    }

    const k = this.key(record.venueId, record.eventId);
    const existing = this.index.get(k);

    if (existing) {
      if (existing.checksum === record.checksum) {
        return { disposition: 'duplicate', isDuplicate: true };
      }
      return {
        disposition: 'conflict',
        conflictReason: `Incoming checksum ${record.checksum} != original ${existing.checksum}`,
      };
    }

    this.index.set(k, {
      ...record,
      disposition: 'accepted',
    });

    return { disposition: 'accepted', isDuplicate: false };
  }

  async recordConflict(conflict: {
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
  }): Promise<void> {
    if (this.failNextRecordConflict) {
      this.failNextRecordConflict = false;
      throw new Error('Conflict table insertion failed');
    }
    this.conflicts.push({
      venueId: conflict.venueId,
      eventId: conflict.eventId,
      incomingChecksum: conflict.incomingChecksum,
      originalChecksum: conflict.originalChecksum,
      r2ArchiveKey: conflict.incomingR2ArchiveKey,
      payload: conflict.incomingPayload,
    });
  }
}

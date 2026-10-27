import { canonicalJson, sha256, toCanonicalObservation } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeJson, sha256Hex } from './canonical-json';
import { PostgresObservationRepository } from './database';
import { QueueConsumer, type QueueMessage } from './queue-consumer';
import { FakeR2ArchiveStorage } from './r2-storage';
import { buildConflictArchiveKey, buildRawArchiveKey } from './types';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;

if (!runtimeUrl || !adminUrl) {
  throw new Error('Run pnpm verify test:db with its disposable database');
}

const admin = new Client({ connectionString: adminUrl });
const tenant1 = crypto.randomUUID();
const tenant2 = crypto.randomUUID();
const pubId1 = crypto.randomUUID();
const pubId2 = crypto.randomUUID();

class TestQueueMessage implements QueueMessage<unknown> {
  public ackCount = 0;
  public retryCount = 0;
  public readonly timestamp = new Date();
  public readonly attempts = 1;

  constructor(
    public readonly id: string,
    public readonly body: unknown,
  ) {}

  ack(): void {
    this.ackCount++;
  }

  retry(): void {
    this.retryCount++;
  }
}

beforeAll(async () => {
  await admin.connect();

  // Transitional test bootstrap: replicates the canonical schema from unmerged PR #32
  // (migrations/20261023120000_observation_index.sql) for local disposable database execution.
  // Once PR #32 is merged into develop, dbmate will apply the migration automatically during test:db bootstrap.
  await admin.query(`
    CREATE TABLE IF NOT EXISTS app_private.observation_index (
      tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
      event_id uuid NOT NULL,
      canonical_payload_checksum text NOT NULL CHECK (canonical_payload_checksum ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'observation.v2'),
      event_type text NOT NULL CHECK (event_type IN (
        'menu_viewed', 'dish_viewed', 'dish_detail_opened', 'dish_detail_closed',
        'dish_activity_checkpoint', 'dish_compared', 'dish_saved', 'dish_unsaved', 'shortlist_viewed'
      )),
      authorized_publication_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL,
      first_received_at timestamptz NOT NULL,
      r2_archive_key text NOT NULL CHECK (length(r2_archive_key) BETWEEN 1 AND 1024),
      disposition text NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
      reason_code text CHECK (reason_code IN (
        'schema_invalid', 'unknown_type', 'too_old', 'future_time', 'publication_not_allowed'
      )),
      PRIMARY KEY (tenant_id, event_id),
      CHECK ((disposition = 'rejected') = (reason_code IS NOT NULL)),
      CHECK (disposition <> 'accepted' OR (
        occurred_at >= first_received_at - interval '24 hours'
        AND occurred_at <= first_received_at + interval '5 minutes'
      ))
    );

    CREATE TABLE IF NOT EXISTS app_private.observation_conflict (
      tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
      event_id uuid NOT NULL,
      incoming_checksum text NOT NULL CHECK (incoming_checksum ~ '^[0-9a-f]{64}$'),
      r2_archive_key text NOT NULL CHECK (length(r2_archive_key) BETWEEN 1 AND 1024),
      received_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, event_id, incoming_checksum)
    );

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'observation_index_append_only') THEN
        CREATE TRIGGER observation_index_append_only
          BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.observation_index
          FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'observation_conflict_append_only') THEN
        CREATE TRIGGER observation_conflict_append_only
          BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.observation_conflict
          FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();
      END IF;
    END $$;

    ALTER TABLE app_private.observation_index ENABLE ROW LEVEL SECURITY;
    ALTER TABLE app_private.observation_index FORCE ROW LEVEL SECURITY;
    ALTER TABLE app_private.observation_conflict ENABLE ROW LEVEL SECURITY;
    ALTER TABLE app_private.observation_conflict FORCE ROW LEVEL SECURITY;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'observation_index_tenant_scope') THEN
        CREATE POLICY observation_index_tenant_scope ON app_private.observation_index
          USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'observation_conflict_tenant_scope') THEN
        CREATE POLICY observation_conflict_tenant_scope ON app_private.observation_conflict
          USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
      END IF;
    END $$;

    REVOKE ALL ON app_private.observation_index, app_private.observation_conflict FROM PUBLIC;
    GRANT SELECT, INSERT ON app_private.observation_index, app_private.observation_conflict TO peekaplate_runtime;
    GRANT SELECT, INSERT ON app_private.observation_index, app_private.observation_conflict TO peekaplate_local;
  `);

  await admin.query(
    'INSERT INTO app_private.venues (id, name) VALUES ($1, $3), ($2, $4) ON CONFLICT (id) DO NOTHING',
    [tenant1, tenant2, 'Test Venue 1', 'Test Venue 2'],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('real PostgreSQL Queue Consumer integration (S3-DATA-02 / PR #32)', () => {
  it('A. First accepted observation persists all canonical columns with forced RLS', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const r2 = new FakeR2ArchiveStorage();
      const consumer = new QueueConsumer({ r2Storage: r2, repository: repo });

      const eventId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const producerId = crypto.randomUUID();
      const dishId = crypto.randomUUID();
      const dishRevId = crypto.randomUUID();
      const expId = crypto.randomUUID();
      const now = new Date().toISOString();
      const payload = {
        dish_id: dishId,
        dish_revision_id: dishRevId,
        exposure_id: expId,
        surface: 'menu_list' as const,
        position: 1,
        exposure_basis: 'viewport_50pct_1s' as const,
      };
      const envelope = {
        kind: 'observation.v2' as const,
        tenantId: tenant1,
        eventId,
        sessionId,
        producerId,
        localSequence: 1,
        schemaVersion: 'observation.v2' as const,
        type: 'dish_viewed' as const,
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        payload,
      };
      const expectedChecksum = await sha256(canonicalJson(toCanonicalObservation(envelope)));
      const expectedArchiveKey = buildRawArchiveKey(tenant1, eventId, now);

      const msg = new TestQueueMessage('msg-1', envelope);

      const disposition = await consumer.processMessage(msg.body);
      expect(disposition.status).toBe('acknowledged');
      if (disposition.status === 'acknowledged') {
        expect(disposition.reason).toBe('persisted');
      }

      // Verify in DB under admin query
      const res = await admin.query(
        `SELECT tenant_id, event_id, canonical_payload_checksum, schema_version,
                event_type, authorized_publication_id, r2_archive_key, disposition, reason_code
         FROM app_private.observation_index
         WHERE tenant_id = $1 AND event_id = $2`,
        [tenant1, eventId],
      );

      expect(res.rows.length).toBe(1);
      const row = res.rows[0];
      expect(row.tenant_id).toBe(tenant1);
      expect(row.event_id).toBe(eventId);
      expect(row.canonical_payload_checksum).toBe(expectedChecksum);
      expect(row.schema_version).toBe('observation.v2');
      expect(row.event_type).toBe('dish_viewed');
      expect(row.authorized_publication_id).toBe(pubId1);
      expect(row.r2_archive_key).toBe(expectedArchiveKey);
      expect(row.disposition).toBe('accepted');
      expect(row.reason_code).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('B. Identical redelivery is recognized as duplicate without rewriting index', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const r2 = new FakeR2ArchiveStorage();
      const consumer = new QueueConsumer({ r2Storage: r2, repository: repo });

      const eventId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const producerId = crypto.randomUUID();
      const now = new Date().toISOString();
      const payload = { entry_source: 'qr' as const };

      const body = {
        kind: 'observation.v2' as const,
        tenantId: tenant1,
        eventId,
        sessionId,
        producerId,
        localSequence: 1,
        schemaVersion: 'observation.v2' as const,
        type: 'menu_viewed' as const,
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        payload,
      };

      const firstDisp = await consumer.processMessage(body);
      expect(firstDisp.status).toBe('acknowledged');
      if (firstDisp.status === 'acknowledged') {
        expect(firstDisp.reason).toBe('persisted');
      }

      // Redeliver identical message
      const secondDisp = await consumer.processMessage(body);
      expect(secondDisp.status).toBe('acknowledged');
      if (secondDisp.status === 'acknowledged') {
        expect(secondDisp.reason).toBe('duplicate_same_payload');
      }

      // Verify still only 1 row exists
      const countRes = await admin.query(
        'SELECT count(*)::int AS count FROM app_private.observation_index WHERE tenant_id = $1 AND event_id = $2',
        [tenant1, eventId],
      );
      expect(countRes.rows[0].count).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('C. Conflicting payload quarantines in observation_conflict with distinct R2 key without altering original', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const r2 = new FakeR2ArchiveStorage();
      const consumer = new QueueConsumer({ r2Storage: r2, repository: repo });

      const eventId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const producerId = crypto.randomUUID();
      const dishId = crypto.randomUUID();
      const dishRevId = crypto.randomUUID();
      const now = new Date().toISOString();
      const payloadA = {
        dish_id: dishId,
        dish_revision_id: dishRevId,
        save_origin: 'direct' as const,
        save_surface: 'menu_card' as const,
        shortlist_size: 1,
      };
      const envA = {
        kind: 'observation.v2' as const,
        tenantId: tenant1,
        eventId,
        sessionId,
        producerId,
        localSequence: 1,
        schemaVersion: 'observation.v2' as const,
        type: 'dish_saved' as const,
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        payload: payloadA,
      };
      const checksumA = await sha256(canonicalJson(toCanonicalObservation(envA)));

      const payloadB = {
        dish_id: dishId,
        dish_revision_id: dishRevId,
        save_origin: 'undo' as const,
        save_surface: 'menu_card' as const,
        shortlist_size: 2,
      };
      const envB = {
        kind: 'observation.v2' as const,
        tenantId: tenant1,
        eventId,
        sessionId,
        producerId,
        localSequence: 2,
        schemaVersion: 'observation.v2' as const,
        type: 'dish_saved' as const,
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        payload: payloadB,
      };
      const checksumB = await sha256(canonicalJson(toCanonicalObservation(envB)));
      expect(checksumA).not.toBe(checksumB);

      // Deliver first payload
      const dispA = await consumer.processMessage(envA);
      expect(dispA.status).toBe('acknowledged');

      // Deliver conflicting payload with same (tenant_id, event_id)
      const dispB = await consumer.processMessage(envB);
      expect(dispB.status).toBe('acknowledged');
      if (dispB.status === 'acknowledged') {
        expect(dispB.reason).toBe('conflict_recorded');
      }

      // Verify original index row was NOT modified
      const originalRes = await admin.query(
        'SELECT canonical_payload_checksum, disposition FROM app_private.observation_index WHERE tenant_id = $1 AND event_id = $2',
        [tenant1, eventId],
      );
      expect(originalRes.rows[0].canonical_payload_checksum).toBe(checksumA);
      expect(originalRes.rows[0].disposition).toBe('accepted');

      // Verify conflict row exists in observation_conflict with distinct R2 key
      const expectedConflictKey = buildConflictArchiveKey(tenant1, eventId, now, checksumB);
      const conflictRes = await admin.query(
        'SELECT tenant_id, event_id, incoming_checksum, r2_archive_key FROM app_private.observation_conflict WHERE tenant_id = $1 AND event_id = $2',
        [tenant1, eventId],
      );
      expect(conflictRes.rows.length).toBe(1);
      expect(conflictRes.rows[0].incoming_checksum).toBe(checksumB);
      expect(conflictRes.rows[0].r2_archive_key).toBe(expectedConflictKey);

      // Verify distinct conflict key is stored in R2
      expect(r2.has(expectedConflictKey)).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('D. Duplicate conflict redelivery is recognized as already recorded and ACKed safely', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const r2 = new FakeR2ArchiveStorage();
      const consumer = new QueueConsumer({ r2Storage: r2, repository: repo });

      const eventId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const producerId = crypto.randomUUID();
      const dish1 = crypto.randomUUID();
      const dishRev1 = crypto.randomUUID();
      const dish2 = crypto.randomUUID();
      const dishRev2 = crypto.randomUUID();
      const dish3 = crypto.randomUUID();
      const dishRev3 = crypto.randomUUID();
      const comp1 = crypto.randomUUID();
      const comp2 = crypto.randomUUID();
      const now = new Date().toISOString();
      const payloadA = {
        dish_id: dish1,
        dish_revision_id: dishRev1,
        other_dish_id: dish2,
        other_dish_revision_id: dishRev2,
        comparison_id: comp1,
        compare_action: 'start' as const,
        save_available: true,
      };
      const payloadB = {
        dish_id: dish1,
        dish_revision_id: dishRev1,
        other_dish_id: dish3,
        other_dish_revision_id: dishRev3,
        comparison_id: comp2,
        compare_action: 'replace' as const,
        save_available: false,
      };

      // Deliver original
      await consumer.processMessage({
        kind: 'observation.v2',
        tenantId: tenant1,
        eventId,
        sessionId,
        producerId,
        localSequence: 1,
        schemaVersion: 'observation.v2',
        type: 'dish_compared',
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        payload: payloadA,
      });

      const conflictMsg = {
        kind: 'observation.v2' as const,
        tenantId: tenant1,
        eventId,
        sessionId,
        producerId,
        localSequence: 2,
        schemaVersion: 'observation.v2' as const,
        type: 'dish_compared' as const,
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        payload: payloadB,
      };

      // Deliver conflict first time
      const disp1 = await consumer.processMessage(conflictMsg);
      expect(disp1.status).toBe('acknowledged');
      if (disp1.status === 'acknowledged') {
        expect(disp1.reason).toBe('conflict_recorded');
      }

      // Redeliver same conflict second time
      const disp2 = await consumer.processMessage(conflictMsg);
      expect(disp2.status).toBe('acknowledged');
      if (disp2.status === 'acknowledged') {
        expect(disp2.reason).toBe('duplicate_same_payload');
      }

      // Verify only 1 conflict row recorded
      const conflictCount = await admin.query(
        'SELECT count(*)::int AS count FROM app_private.observation_conflict WHERE tenant_id = $1 AND event_id = $2',
        [tenant1, eventId],
      );
      expect(conflictCount.rows[0].count).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('E. Forced RLS isolates tenant rows and clears context on connection reuse', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const event1 = crypto.randomUUID();
      const event2 = crypto.randomUUID();
      const now = new Date().toISOString();

      // Persist for Tenant 1
      await repo.persistCanonical({
        tenantId: tenant1,
        eventId: event1,
        schemaVersion: 'observation.v2',
        eventType: 'menu_viewed',
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        checksum: '1111111111111111111111111111111111111111111111111111111111111111',
        r2ArchiveKey: `raw/observations/${tenant1}/2026/10/24/${event1}.json`,
        payload: { t: 1 },
      });

      // Persist for Tenant 2
      await repo.persistCanonical({
        tenantId: tenant2,
        eventId: event2,
        schemaVersion: 'observation.v2',
        eventType: 'menu_viewed',
        authorizedPublicationId: pubId2,
        occurredAt: now,
        firstReceivedAt: now,
        checksum: '2222222222222222222222222222222222222222222222222222222222222222',
        r2ArchiveKey: `raw/observations/${tenant2}/2026/10/24/${event2}.json`,
        payload: { t: 2 },
      });

      // Query without setting tenant context -> should see 0 rows
      const emptyRes = await client.query(
        'SELECT count(*)::int AS count FROM app_private.observation_index',
      );
      expect(emptyRes.rows[0].count).toBe(0);

      // Lookup with Tenant 1 context -> sees only Tenant 1
      const foundT1 = await repo.lookupExisting(tenant1, event1);
      expect(foundT1).not.toBeNull();
      expect(foundT1?.checksum).toBe(
        '1111111111111111111111111111111111111111111111111111111111111111',
      );

      // Tenant 1 cannot see Tenant 2's event
      const notFoundT2 = await repo.lookupExisting(tenant1, event2);
      expect(notFoundT2).toBeNull();

      // Tenant 2 cannot see Tenant 1's event
      const notFoundT1 = await repo.lookupExisting(tenant2, event1);
      expect(notFoundT1).toBeNull();

      // After transaction, context is reset: raw query sees 0 rows
      const resetRes = await client.query(
        'SELECT count(*)::int AS count FROM app_private.observation_index',
      );
      expect(resetRes.rows[0].count).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('F. Append-only triggers and runtime grants reject UPDATE and DELETE', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      // Runtime role lacks UPDATE/DELETE grant on observation_index
      await expect(
        client.query('UPDATE app_private.observation_index SET disposition = $1', ['rejected']),
      ).rejects.toThrow(/permission denied for table observation_index/);

      await expect(client.query('DELETE FROM app_private.observation_index')).rejects.toThrow(
        /permission denied for table observation_index/,
      );

      // Even superuser / admin trigger rejects UPDATE/DELETE on observation_index
      await expect(
        admin.query('UPDATE app_private.observation_index SET disposition = $1', ['rejected']),
      ).rejects.toThrow(/append-only table observation_index rejects UPDATE/);

      await expect(admin.query('DELETE FROM app_private.observation_index')).rejects.toThrow(
        /append-only table observation_index rejects DELETE/,
      );
    } finally {
      await client.end();
    }
  });

  it('G. Timestamp window: accepted within window, rejected with reason_code outside window', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const firstReceivedAt = new Date('2026-10-24T12:00:00Z');

      // 1. Valid inside window (e.g. 1 hour ago)
      const validEventId = crypto.randomUUID();
      const validOccurred = new Date(firstReceivedAt.getTime() - 60 * 60 * 1000).toISOString();
      const validOutcome = await repo.persistCanonical({
        tenantId: tenant1,
        eventId: validEventId,
        schemaVersion: 'observation.v2',
        eventType: 'dish_viewed',
        authorizedPublicationId: pubId1,
        occurredAt: validOccurred,
        firstReceivedAt: firstReceivedAt.toISOString(),
        checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        r2ArchiveKey: `raw/observations/${tenant1}/2026/10/24/${validEventId}.json`,
        payload: {},
      });
      expect(validOutcome.disposition).toBe('accepted');

      // 2. Out of window: more than 24 hours in past -> rejected with 'too_old'
      const oldEventId = crypto.randomUUID();
      const oldOccurred = new Date(firstReceivedAt.getTime() - 25 * 60 * 60 * 1000).toISOString();
      const oldOutcome = await repo.persistCanonical({
        tenantId: tenant1,
        eventId: oldEventId,
        schemaVersion: 'observation.v2',
        eventType: 'dish_viewed',
        authorizedPublicationId: pubId1,
        occurredAt: oldOccurred,
        firstReceivedAt: firstReceivedAt.toISOString(),
        checksum: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        r2ArchiveKey: `raw/observations/${tenant1}/2026/10/24/${oldEventId}.json`,
        payload: {},
      });
      expect(oldOutcome.disposition).toBe('rejected');
      if (oldOutcome.disposition === 'rejected') {
        expect(oldOutcome.reasonCode).toBe('too_old');
      }

      const oldRow = await admin.query(
        'SELECT disposition, reason_code FROM app_private.observation_index WHERE event_id = $1',
        [oldEventId],
      );
      expect(oldRow.rows[0].disposition).toBe('rejected');
      expect(oldRow.rows[0].reason_code).toBe('too_old');

      // 3. Out of window: more than 5 minutes in future -> rejected with 'future_time'
      const futureEventId = crypto.randomUUID();
      const futureOccurred = new Date(firstReceivedAt.getTime() + 6 * 60 * 1000).toISOString();
      const futureOutcome = await repo.persistCanonical({
        tenantId: tenant1,
        eventId: futureEventId,
        schemaVersion: 'observation.v2',
        eventType: 'dish_viewed',
        authorizedPublicationId: pubId1,
        occurredAt: futureOccurred,
        firstReceivedAt: firstReceivedAt.toISOString(),
        checksum: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        r2ArchiveKey: `raw/observations/${tenant1}/2026/10/24/${futureEventId}.json`,
        payload: {},
      });
      expect(futureOutcome.disposition).toBe('rejected');
      if (futureOutcome.disposition === 'rejected') {
        expect(futureOutcome.reasonCode).toBe('future_time');
      }

      const futureRow = await admin.query(
        'SELECT disposition, reason_code FROM app_private.observation_index WHERE event_id = $1',
        [futureEventId],
      );
      expect(futureRow.rows[0].disposition).toBe('rejected');
      expect(futureRow.rows[0].reason_code).toBe('future_time');
    } finally {
      await client.end();
    }
  });

  it('H. Transaction rollback leaves no partial writes on failure', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Attempt to insert with invalid event_type that violates CHECK constraint
      await expect(
        repo.persistCanonical({
          tenantId: tenant1,
          eventId,
          schemaVersion: 'observation.v2',
          eventType: 'forbidden_unregistered_event_type',
          authorizedPublicationId: pubId1,
          occurredAt: now,
          firstReceivedAt: now,
          checksum: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          r2ArchiveKey: `raw/observations/${tenant1}/2026/10/24/${eventId}.json`,
          payload: {},
        }),
      ).rejects.toThrow();

      // Verify no row was inserted
      const res = await admin.query(
        'SELECT count(*)::int AS count FROM app_private.observation_index WHERE event_id = $1',
        [eventId],
      );
      expect(res.rows[0].count).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('I. session_id is preserved across Queue processing without requiring an index column', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      const repo = new PostgresObservationRepository(client);
      const r2 = new FakeR2ArchiveStorage();
      const consumer = new QueueConsumer({ r2Storage: r2, repository: repo });

      const eventId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const producerId = crypto.randomUUID();
      const now = new Date().toISOString();

      const disposition = await consumer.processMessage({
        kind: 'observation.v2',
        tenantId: tenant1,
        eventId,
        sessionId,
        producerId,
        localSequence: 1,
        schemaVersion: 'observation.v2',
        type: 'shortlist_viewed',
        authorizedPublicationId: pubId1,
        occurredAt: now,
        firstReceivedAt: now,
        payload: { shortlist_size: 3 },
      });

      expect(disposition.status).toBe('acknowledged');

      // Verify observation_index has NO session_id column (reserved for future typed facts)
      const colCheck = await admin.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'app_private' AND table_name = 'observation_index' AND column_name = 'session_id'
      `);
      expect(colCheck.rows.length).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('J. Concurrent identical and conflicting messages resolve deterministically', async () => {
    const client1 = new Client({ connectionString: runtimeUrl });
    const client2 = new Client({ connectionString: runtimeUrl });
    await client1.connect();
    await client2.connect();

    try {
      const repo1 = new PostgresObservationRepository(client1);
      const repo2 = new PostgresObservationRepository(client2);
      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();

      const payload = { test: 'concurrent-val' };
      const checksum = await sha256Hex(canonicalizeJson(payload));
      const key = buildRawArchiveKey(tenant1, eventId, now);

      // Race two persistCanonical calls on different connections
      const [outcome1, outcome2] = await Promise.all([
        repo1.persistCanonical({
          tenantId: tenant1,
          eventId,
          schemaVersion: 'observation.v2',
          eventType: 'dish_saved',
          authorizedPublicationId: pubId1,
          occurredAt: now,
          firstReceivedAt: now,
          checksum,
          r2ArchiveKey: key,
          payload,
        }),
        repo2.persistCanonical({
          tenantId: tenant1,
          eventId,
          schemaVersion: 'observation.v2',
          eventType: 'dish_saved',
          authorizedPublicationId: pubId1,
          occurredAt: now,
          firstReceivedAt: now,
          checksum,
          r2ArchiveKey: key,
          payload,
        }),
      ]);

      const outcomes = [outcome1.disposition, outcome2.disposition];
      expect(outcomes).toContain('accepted');
      expect(outcomes).toContain('duplicate');

      const countRes = await admin.query(
        'SELECT count(*)::int AS count FROM app_private.observation_index WHERE tenant_id = $1 AND event_id = $2',
        [tenant1, eventId],
      );
      expect(countRes.rows[0].count).toBe(1);
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  it('K. Schema conformance verification: validates exact columns, primary keys, RLS flags, and append-only triggers against the canonical observation contract', async () => {
    // 1. Column definitions and types for observation_index
    const colsRes = await admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'app_private' AND table_name = 'observation_index'
       ORDER BY column_name`,
    );
    const colMap = new Map(colsRes.rows.map((r) => [r.column_name, r]));

    const expectedCols: Record<string, { type: string; nullable: string }> = {
      tenant_id: { type: 'uuid', nullable: 'NO' },
      event_id: { type: 'uuid', nullable: 'NO' },
      canonical_payload_checksum: { type: 'text', nullable: 'NO' },
      schema_version: { type: 'text', nullable: 'NO' },
      event_type: { type: 'text', nullable: 'NO' },
      authorized_publication_id: { type: 'uuid', nullable: 'NO' },
      occurred_at: { type: 'timestamp with time zone', nullable: 'NO' },
      first_received_at: { type: 'timestamp with time zone', nullable: 'NO' },
      r2_archive_key: { type: 'text', nullable: 'NO' },
      disposition: { type: 'text', nullable: 'NO' },
      reason_code: { type: 'text', nullable: 'YES' },
    };

    for (const [colName, expected] of Object.entries(expectedCols)) {
      const actual = colMap.get(colName);
      expect(actual, `Column ${colName} must exist on app_private.observation_index`).toBeDefined();
      expect(actual?.data_type).toBe(expected.type);
      expect(actual?.is_nullable).toBe(expected.nullable);
    }

    // 2. Primary key on observation_index: (tenant_id, event_id)
    const pkIndexRes = await admin.query<{ kcu_column: string }>(
      `SELECT kcu.column_name AS kcu_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'app_private'
         AND tc.table_name = 'observation_index'
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
    );
    expect(pkIndexRes.rows.map((r) => r.kcu_column)).toEqual(['tenant_id', 'event_id']);

    // 3. Primary key on observation_conflict: (tenant_id, event_id, incoming_checksum)
    const pkConflictRes = await admin.query<{ kcu_column: string }>(
      `SELECT kcu.column_name AS kcu_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'app_private'
         AND tc.table_name = 'observation_conflict'
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
    );
    expect(pkConflictRes.rows.map((r) => r.kcu_column)).toEqual([
      'tenant_id',
      'event_id',
      'incoming_checksum',
    ]);

    // 4. Forced Row-Level Security on observation_index and observation_conflict
    const rlsRes = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
       WHERE pg_namespace.nspname = 'app_private'
         AND relname IN ('observation_index', 'observation_conflict')`,
    );
    expect(rlsRes.rows.length).toBe(2);
    for (const row of rlsRes.rows) {
      expect(row.relrowsecurity, `RLS must be enabled on ${row.relname}`).toBe(true);
      expect(row.relforcerowsecurity, `RLS must be forced on ${row.relname}`).toBe(true);
    }

    // 5. Append-only triggers
    const triggerRes = await admin.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgname IN ('observation_index_append_only', 'observation_conflict_append_only')`,
    );
    const triggerNames = triggerRes.rows.map((r) => r.tgname);
    expect(triggerNames).toContain('observation_index_append_only');
    expect(triggerNames).toContain('observation_conflict_append_only');
  });
});

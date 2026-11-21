import { createHash } from 'node:crypto';
import {
  canonicalJson,
  ObservationQueueMessageSchema,
  OwnerDishReportSchema,
} from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresObservationRepository } from '../consumer/database';
import { QueueConsumer } from '../consumer/queue-consumer';
import { FakeR2ArchiveStorage } from '../consumer/r2-storage';
import { buildRawArchiveKey } from '../consumer/types';
import { readOwnerReport } from '../owner-report';
import { SYNTHETIC_EVIDENCE_QUERY, syntheticEvidenceDigests } from './synthetic-completeness';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
describe.skipIf(!runtimeUrl || !adminUrl).each(['menu_viewed', 'dish_portion_opened'] as const)(
  'sealed synthetic completeness for %s (real tenant-scoped PostgreSQL)',
  (type) => {
    const admin = new Client({ connectionString: adminUrl });
    const runtime = new Client({ connectionString: runtimeUrl });
    const tenant = crypto.randomUUID();
    const actor = crypto.randomUUID();
    const now = new Date('2035-02-03T00:00:00.000Z');
    const storage = new FakeR2ArchiveStorage();
    const consumer = new QueueConsumer({
      r2Storage: storage,
      repository: new PostgresObservationRepository(runtime),
    });
    let seal: string;
    const envelope = ObservationQueueMessageSchema.parse({
      kind: 'observation.v2',
      schemaVersion: 'observation.v2',
      tenantId: tenant,
      eventId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      producerId: crypto.randomUUID(),
      localSequence: 1,
      authorizedPublicationId: tenant,
      type,
      occurredAt: '2035-02-02T23:00:00.000Z',
      firstReceivedAt: '2035-02-02T23:00:01.000Z',
      traffic_class: 'test',
      payload:
        type === 'menu_viewed'
          ? { entry_source: 'qr' }
          : { dish_id: crypto.randomUUID(), dish_revision_id: crypto.randomUUID() },
    });
    beforeAll(async () => {
      await admin.connect();
      await runtime.connect();
      await admin.query(
        "INSERT INTO app_private.venues(id,name) VALUES($1,'Scripted completeness fixture')",
        [tenant],
      );
      await admin.query(
        "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner')",
        [tenant, actor],
      );
      expect(await consumer.processMessage(envelope)).toMatchObject({
        status: 'acknowledged',
        reason: 'persisted',
      });
      const rows = await admin.query(SYNTHETIC_EVIDENCE_QUERY, [
        tenant,
        new Date(now.getTime() - 86_400_000),
        now,
      ]);
      const digests = syntheticEvidenceDigests(rows.rows);
      const archive = await storage.getRawPayload(buildRawArchiveKey(tenant, envelope.eventId));
      expect(archive).not.toBeNull();
      expect(archive?.checksum).toBe(rows.rows[0].index.canonical_payload_checksum);
      seal = JSON.stringify({
        version: 1,
        kind: 'sealed_scripted_scenario',
        venue_id: tenant,
        publication_revision_id: tenant,
        manifest_sha256: createHash('sha256').update(canonicalJson(envelope)).digest('hex'),
        event_count: 1,
        ...digests,
        producer_closed_at: '2035-02-02T23:01:00.000Z',
        sealed_at: '2035-02-02T23:59:00.000Z',
        expires_at: '2035-02-03T00:10:00.000Z',
        archive_proof: {
          kind: 'operator_verified_create_only_r2',
          verified_at: '2035-02-02T23:58:00.000Z',
          reconciliation_sha256: createHash('sha256').update(archive!.rawBytes).digest('hex'),
          ...digests,
        },
      });
    });
    afterAll(async () => {
      await runtime.end();
      await admin.end();
    });
    const read = () =>
      readOwnerReport(runtime, actor, tenant, now, 'synthetic', {
        trafficClass: 'test',
        includeSummary: true,
        syntheticSeal: seal,
        validationNow: now,
      });
    it('matches real canonical index and typed JSON under the restricted runtime role; retries preserve proof', async () => {
      expect(OwnerDishReportSchema.parse(await read()).report_metadata.freshness.is_stale).toBe(
        false,
      );
      expect(await consumer.processMessage(envelope)).toMatchObject({
        reason: 'duplicate_same_payload',
      });
      expect(OwnerDishReportSchema.parse(await read()).report_metadata.freshness.is_stale).toBe(
        false,
      );
    });
    it('late extra canonical fact invalidates the sealed set', async () => {
      expect(
        await consumer.processMessage({
          ...envelope,
          eventId: crypto.randomUUID(),
          localSequence: 2,
        }),
      ).toMatchObject({ reason: 'persisted' });
      expect(
        OwnerDishReportSchema.parse(await read()).report_metadata.freshness.is_stale,
      ).toBeNull();
    });
    it('current owner revocation denies the read despite the seal', async () => {
      await admin.query(
        'DELETE FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2',
        [tenant, actor],
      );
      await expect(read()).rejects.toMatchObject({ status: 403 });
    });
  },
);

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  type ObservationQueueMessage,
  ObservationV2Schema,
  sha256,
  toCanonicalObservation,
} from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ingestObservations } from '../observation-ingest';
import { backfillObservationFacts } from './backfill';
import { PostgresObservationRepository } from './database';
import { QueueConsumer } from './queue-consumer';
import { FakeR2ArchiveStorage } from './r2-storage';
import { buildRawArchiveKey } from './types';
import type { ObservationRepository } from './types';

const admin = new Client({ connectionString: process.env.PEEKAPLATE_DB_ADMIN_URL });
const client = new Client({ connectionString: process.env.PEEKAPLATE_DB_TEST_URL });
const tenantId = crypto.randomUUID();
const publicationId = crypto.randomUUID();
const now = new Date('2026-11-02T12:00:00Z');
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../packages/contracts/fixtures/observation.v2/fixtures.json', import.meta.url)
        .href,
    ),
    'utf8',
  ),
);
const events = fixture.valid_events.map((event: Record<string, unknown>) =>
  ObservationV2Schema.parse({
    ...event,
    event_id: crypto.randomUUID(),
    publication_revision_id: publicationId,
    occurred_at: now.toISOString(),
  }),
);
const storage = new FakeR2ArchiveStorage();
const consumer = new QueueConsumer({
  r2Storage: storage,
  repository: new PostgresObservationRepository(client),
});

async function message(type = 'menu_viewed', trafficClass: 'live' | 'test' | 'demo' = 'test') {
  const input = {
    ...events.find((event: { type: string }) => event.type === type),
    event_id: crypto.randomUUID(),
  };
  const messages: ObservationQueueMessage[] = [];
  await ingestObservations(
    [input],
    { venueId: tenantId, publicationId, jti: crypto.randomUUID(), trafficClass },
    {
      now: () => now,
      enqueue: async (envelope) => {
        if (envelope.kind === 'observation.v2') messages.push(envelope);
      },
    },
  );
  return messages[0]!;
}

async function historic(
  envelope: ObservationQueueMessage,
  tenant: string = tenantId,
  archiveStorage: FakeR2ArchiveStorage = storage,
) {
  const checksum = await sha256(canonicalJson(toCanonicalObservation(envelope)));
  const key = buildRawArchiveKey(tenant, envelope.eventId);

  await archiveStorage.putRawPayload(
    key,
    new TextEncoder().encode(JSON.stringify(envelope)),
    checksum,
  );

  await new PostgresObservationRepository(client).persistCanonical({
    tenantId: tenant,
    eventId: envelope.eventId,
    schemaVersion: envelope.schemaVersion,
    eventType: envelope.type,
    authorizedPublicationId: envelope.authorizedPublicationId,
    occurredAt: envelope.occurredAt,
    firstReceivedAt: envelope.firstReceivedAt,
    checksum,
    r2ArchiveKey: key,
    payload: envelope.payload,
  });
}

beforeAll(async () => {
  await admin.connect();
  await client.connect();
  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
    tenantId,
    'Synthetic facts test',
  ]);
});
afterAll(async () => {
  await client.end();
  await admin.end();
});

it('persists all nine typed event families atomically and keeps test traffic out of owner views', async () => {
  const messages: unknown[] = [];
  await ingestObservations(
    events,
    { venueId: tenantId, publicationId, jti: crypto.randomUUID(), trafficClass: 'test' },
    {
      now: () => now,
      enqueue: async (message) => {
        messages.push(message);
      },
    },
  );
  for (const message of messages) {
    const outcome = await consumer.processMessage(message);
    expect(outcome, outcome.status === 'retry' ? outcome.error.message : '').toMatchObject({
      status: 'acknowledged',
    });
    expect((await consumer.processMessage(message)).status).toBe('acknowledged');
  }
  const result = await admin.query(
    'SELECT event_type, traffic_class FROM app_private.observation_event WHERE tenant_id=$1 ORDER BY event_type',
    [tenantId],
  );
  expect(result.rows.map((row) => row.event_type)).toEqual(
    events.map((event: { type: string }) => event.type).sort(),
  );
  expect(result.rows.every((row) => row.traffic_class === 'test')).toBe(true);
  for (const table of [
    'menu_view',
    'exposure',
    'opening',
    'activity',
    'closing',
    'comparison',
    'save',
    'shortlist_view',
  ]) {
    const count = await admin.query(
      `SELECT count(*)::int AS count FROM app_private.observation_${table} WHERE tenant_id=$1`,
      [tenantId],
    );
    expect(count.rows[0].count).toBe(table === 'save' ? 2 : 1);
  }
  expect(
    (
      await admin.query('SELECT * FROM app_private.owner_observation_v1 WHERE tenant_id=$1', [
        tenantId,
      ])
    ).rowCount,
  ).toBe(0);
});

it('backfills old accepted rows idempotently from the original archive and keeps their test class', async () => {
  const envelope = await message();
  await historic(envelope);
  expect((await consumer.processMessage({ ...envelope, traffic_class: 'live' })).status).toBe(
    'acknowledged',
  );
  expect(
    (
      await admin.query(
        'SELECT traffic_class FROM app_private.observation_event WHERE event_id=$1',
        [envelope.eventId],
      )
    ).rows[0].traffic_class,
  ).toBe('test');
  const old = await message('menu_viewed', 'demo');
  await historic(old);
  expect(await backfillObservationFacts(client, storage, tenantId)).toContainEqual({
    eventId: old.eventId,
    status: 'restored',
  });
  expect(await backfillObservationFacts(client, storage, tenantId)).toEqual([]);
  expect(
    (
      await admin.query(
        'SELECT * FROM app_private.owner_observation_v1 WHERE event_id=ANY($1::uuid[])',
        [[old.eventId, envelope.eventId]],
      )
    ).rowCount,
  ).toBe(0);
});

it('rolls back index and event when a detail check fails; retries never hide that failure', async () => {
  const envelope = await message('dish_detail_opened');
  const invalid = { ...envelope, payload: { ...envelope.payload, source: 'direct' } };
  for (let attempt = 0; attempt < 2; attempt++)
    expect((await consumer.processMessage(invalid)).status).toBe('retry');
  expect(
    (
      await admin.query('SELECT * FROM app_private.observation_index WHERE event_id=$1', [
        envelope.eventId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await admin.query('SELECT * FROM app_private.observation_event WHERE event_id=$1', [
        envelope.eventId,
      ])
    ).rowCount,
  ).toBe(0);
});

it('persists live facts once under concurrent deliveries and keeps tenant context transaction-local', async () => {
  const envelope = await message('menu_viewed', 'live');
  const second = new Client({ connectionString: process.env.PEEKAPLATE_DB_TEST_URL });
  await second.connect();
  try {
    const otherConsumer = new QueueConsumer({
      r2Storage: storage,
      repository: new PostgresObservationRepository(second),
    });
    const results = await Promise.all([
      consumer.processMessage(envelope),
      otherConsumer.processMessage(envelope),
    ]);
    expect(results.every((result) => result.status === 'acknowledged')).toBe(true);
    expect(
      (
        await admin.query('SELECT * FROM app_private.owner_observation_v1 WHERE event_id=$1', [
          envelope.eventId,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await client.query('SELECT * FROM app_private.observation_event')).rowCount).toBe(0);
  } finally {
    await second.end();
  }
});

it('uses the greatest cumulative checkpoint regardless of delivery order', async () => {
  const first = await message('dish_activity_checkpoint', 'live');
  const openingId = crypto.randomUUID();
  const dishId = first.payload.dish_id;
  const dishRevisionId = first.payload.dish_revision_id;

  const highCheckpoint = {
    ...first,
    payload: {
      ...first.payload,
      opening_id: openingId,
      dish_id: dishId,
      dish_revision_id: dishRevisionId,
      active_ms: 10_000,
      final: false,
    },
  };

  const lowFinalCheckpoint = {
    ...first,
    eventId: crypto.randomUUID(),
    localSequence: first.localSequence + 1,
    payload: {
      ...first.payload,
      opening_id: openingId,
      dish_id: dishId,
      dish_revision_id: dishRevisionId,
      active_ms: 5_000,
      final: true,
    },
  };

  // Deliver the larger cumulative checkpoint first, then the smaller final one.
  expect((await consumer.processMessage(highCheckpoint)).status).toBe('acknowledged');
  expect((await consumer.processMessage(lowFinalCheckpoint)).status).toBe('acknowledged');

  const result = await admin.query(
    `SELECT active_ms, has_final_checkpoint, checkpoint_count
     FROM app_private.owner_opening_activity_v1
     WHERE tenant_id = $1
       AND opening_id = $2
       AND dish_id = $3
       AND dish_revision_id = $4`,
    [tenantId, openingId, dishId, dishRevisionId],
  );

   expect(result.rows).toHaveLength(1);

  expect(result.rows[0]).toMatchObject({
    active_ms: 10_000,
    has_final_checkpoint: true,
    checkpoint_count: '2',
  });
});

it('does not ACK a semantic detail collision as a transport duplicate', async () => {
  const first = await message('dish_viewed');
  first.payload.exposure_id = crypto.randomUUID();
  expect((await consumer.processMessage(first)).status).toBe('acknowledged');
  const second = { ...first, eventId: crypto.randomUUID(), localSequence: first.localSequence + 1 };
  expect((await consumer.processMessage(second)).status).toBe('retry');
  expect((await consumer.processMessage(second)).status).toBe('retry');
  expect(
    (
      await admin.query('SELECT * FROM app_private.observation_index WHERE event_id=$1', [
        second.eventId,
      ])
    ).rowCount,
  ).toBe(0);
});

it('blocks historic archives with missing classification and never reclassifies rejected rows', async () => {
  const envelope = await message();
  const { traffic_class: _classification, ...unknownClass } = envelope;
  await historic(unknownClass as ObservationQueueMessage);
  const old = { ...(await message()), occurredAt: '2026-10-01T12:00:00Z' };
  await historic(old);
  expect(await backfillObservationFacts(client, storage, tenantId)).toEqual([
    { eventId: envelope.eventId, status: 'blocked' },
  ]);
  expect(
    (
      await admin.query(
        'SELECT * FROM app_private.observation_event WHERE event_id=ANY($1::uuid[])',
        [[old.eventId, envelope.eventId]],
      )
    ).rowCount,
  ).toBe(0);
  expect(await backfillObservationFacts(client, storage, crypto.randomUUID())).toEqual([]);
  expect((await consumer.processMessage(unknownClass)).status).toBe('acknowledged');
  expect(
    (
      await admin.query('SELECT * FROM app_private.observation_event WHERE event_id=$1', [
        envelope.eventId,
      ])
    ).rowCount,
  ).toBe(0);
});
it('blocks a missing archive without creating canonical event or fact rows', async () => {
  const isolatedTenant = crypto.randomUUID();
  const isolatedStorage = new FakeR2ArchiveStorage();
  const envelope = await message();

  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
    isolatedTenant,
    'Missing archive test',
  ]);
  await historic(envelope, isolatedTenant, isolatedStorage);

  const key = buildRawArchiveKey(isolatedTenant, envelope.eventId);
  expect(isolatedStorage.delete(key)).toBe(true);

  expect(
    await backfillObservationFacts(client, isolatedStorage, isolatedTenant),
  ).toEqual([{ eventId: envelope.eventId, status: 'blocked' }]);

  expect(
    (
      await admin.query(
        'SELECT * FROM app_private.observation_event WHERE tenant_id=$1 AND event_id=$2',
        [isolatedTenant, envelope.eventId],
      )
    ).rowCount,
  ).toBe(0);
});

it('blocks corrupt archive bytes even when the stored checksum metadata matches', async () => {
  const isolatedTenant = crypto.randomUUID();
  const isolatedStorage = new FakeR2ArchiveStorage();
  const envelope = await message();

  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
    isolatedTenant,
    'Corrupt archive test',
  ]);
  await historic(envelope, isolatedTenant, isolatedStorage);

  const key = buildRawArchiveKey(isolatedTenant, envelope.eventId);
  const checksum = await sha256(canonicalJson(toCanonicalObservation(envelope)));

  isolatedStorage.setExisting(
    key,
    new TextEncoder().encode('{"corrupt":true}'),
    checksum,
  );

  expect(
    await backfillObservationFacts(client, isolatedStorage, isolatedTenant),
  ).toEqual([{ eventId: envelope.eventId, status: 'blocked' }]);

  expect(
    (
      await admin.query(
        'SELECT * FROM app_private.observation_event WHERE tenant_id=$1 AND event_id=$2',
        [isolatedTenant, envelope.eventId],
      )
    ).rowCount,
  ).toBe(0);
});

it('blocks a mismatched archive checksum without creating canonical event rows', async () => {
  const isolatedTenant = crypto.randomUUID();
  const isolatedStorage = new FakeR2ArchiveStorage();
  const envelope = await message();

  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
    isolatedTenant,
    'Checksum mismatch test',
  ]);
  await historic(envelope, isolatedTenant, isolatedStorage);

  const key = buildRawArchiveKey(isolatedTenant, envelope.eventId);
  const archive = await isolatedStorage.getRawPayload(key);
  expect(archive).not.toBeNull();

  isolatedStorage.setExisting(key, archive!.rawBytes, '0'.repeat(64));

  expect(
    await backfillObservationFacts(client, isolatedStorage, isolatedTenant),
  ).toEqual([{ eventId: envelope.eventId, status: 'blocked' }]);

  expect(
    (
      await admin.query(
        'SELECT * FROM app_private.observation_event WHERE tenant_id=$1 AND event_id=$2',
        [isolatedTenant, envelope.eventId],
      )
    ).rowCount,
  ).toBe(0);
});

it('keeps database-failed backfill work eligible for a later successful retry', async () => {
  const envelope = await message();
  await historic(envelope);

  const repository = new PostgresObservationRepository(client);
  let failOnce = true;

  const failingRepository: ObservationRepository = {
    lookupExisting: (...args) => repository.lookupExisting(...args),
    persistCanonical: async (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('Synthetic database failure');
      }
      return repository.persistCanonical(...args);
    },
    recordConflict: (...args) => repository.recordConflict(...args),
  };

  const failingConsumer = new QueueConsumer({
    r2Storage: storage,
    repository: failingRepository,
  });

  // Use a temporary consumer through the same backfill path.
  const key = buildRawArchiveKey(tenantId, envelope.eventId);
  const archive = await storage.getRawPayload(key);
  expect(archive).not.toBeNull();

  // First verify the injected persistence failure is returned as blocked.
  const outcome = await failingConsumer.processMessage(envelope);
  expect(outcome.status).toBe('retry');

  // The normal backfill can then safely retry the same archived observation.
  expect(await backfillObservationFacts(client, storage, tenantId)).toContainEqual({
    eventId: envelope.eventId,
    status: 'restored',
  });
});
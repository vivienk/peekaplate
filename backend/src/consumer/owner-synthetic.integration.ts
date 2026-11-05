import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, ObservationV2Schema, toCanonicalObservation } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ingestObservations } from '../observation-ingest';
import { sha256Hex } from './canonical-json';
import { PostgresObservationRepository } from './database';
import { QueueConsumer } from './queue-consumer';
import { FakeR2ArchiveStorage } from './r2-storage';

type FixtureEvent = Record<string, unknown>;

const admin = new Client({
  connectionString: process.env.PEEKAPLATE_DB_ADMIN_URL,
});
const client = new Client({
  connectionString: process.env.PEEKAPLATE_DB_TEST_URL,
});

const tenantId = randomUUID();
const publicationId = randomUUID();
const producerId = randomUUID();

// Original fixture timestamps are October 20, 2026 (+05:00).
// The fixed ingestion time keeps every event inside the accepted window.
const now = new Date('2026-10-20T12:00:00+05:00');

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test-data/owner-synthetic-p0-v2/events/two_session_story.jsonl',
);

const fixtureEvents: FixtureEvent[] = readFileSync(fixturePath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as FixtureEvent);

// Stable within this test run. Repeated fixture identifiers always map
// to the same UUID, including the repeated evt-x-011 delivery.
const ids = new Map<string, string>();

function idFor(namespace: string, value: string): string {
  const key = `${namespace}:${value}`;
  let id = ids.get(key);

  if (!id) {
    id = randomUUID();
    ids.set(key, id);
  }

  return id;
}

function dishId(value: unknown): string {
  return idFor('dish', String(value));
}

function dishRevisionId(value: unknown): string {
  // Test-only synthetic revision identity. The fixture does not provide
  // production dish_revision_id values.
  return idFor('dish-revision', String(value));
}

function toCanonicalFixtureEvent(fixture: FixtureEvent, positions: Map<string, number>) {
  const session = String(fixture.session_id);

  const base = {
    schema_version: 'observation.v2',
    event_id: idFor('event', String(fixture.event_id)),
    session_id: idFor('session', session),
    producer_id: producerId,
    publication_revision_id: publicationId,
    local_sequence: Number(fixture.local_sequence),
    occurred_at: String(fixture.occurred_at),
    type: String(fixture.event_type),
  };

  let payload: Record<string, unknown>;

  switch (fixture.event_type) {
    case 'menu_viewed':
      payload = {
        entry_source: fixture.entry_source,
      };
      break;

    case 'dish_viewed': {
      const dish = String(fixture.dish_id);
      const position = (positions.get(session) ?? 0) + 1;
      positions.set(session, position);

      payload = {
        dish_id: dishId(dish),
        dish_revision_id: dishRevisionId(dish),
        exposure_id: idFor('exposure', String(fixture.exposure_id)),
        surface: 'menu_list',
        position,
        exposure_basis: 'viewport_50pct_1s',
      };
      break;
    }

    case 'dish_detail_opened': {
      const dish = String(fixture.dish_id);

      payload = {
        dish_id: dishId(dish),
        dish_revision_id: dishRevisionId(dish),
        opening_id: idFor('opening', String(fixture.opening_id)),
        source: fixture.surface,
        from_exposure_id: idFor('exposure', String(fixture.exposure_id)),
        // Test-only assumption: the synthetic fixture omits this field.
        save_available: true,
      };
      break;
    }

    case 'dish_activity_checkpoint': {
      const dish = String(fixture.dish_id);

      payload = {
        dish_id: dishId(dish),
        dish_revision_id: dishRevisionId(dish),
        opening_id: idFor('opening', String(fixture.opening_id)),
        active_ms: Number(fixture.cumulative_active_ms),
        final: Boolean(fixture.is_final),
      };
      break;
    }

    case 'dish_compared': {
      const dishIds = fixture.dish_ids as string[];

      if (!Array.isArray(dishIds) || dishIds.length !== 2) {
        throw new Error('Expected exactly two dish IDs in comparison fixture');
      }

      payload = {
        dish_id: dishId(dishIds[0]),
        dish_revision_id: dishRevisionId(dishIds[0]),
        other_dish_id: dishId(dishIds[1]),
        other_dish_revision_id: dishRevisionId(dishIds[1]),
        comparison_id: idFor('comparison', String(fixture.comparison_id)),
        compare_action: fixture.compare_action,
        // Test-only assumption: the synthetic fixture omits this field.
        save_available: true,
      };
      break;
    }

    case 'dish_saved': {
      const dish = String(fixture.dish_id);

      payload = {
        dish_id: dishId(dish),
        dish_revision_id: dishRevisionId(dish),
        save_origin: fixture.save_origin,
        save_surface: fixture.save_surface,
        shortlist_size: Number(fixture.shortlist_size),
      };
      break;
    }

    case 'dish_unsaved': {
      const dish = String(fixture.dish_id);

      payload = {
        dish_id: dishId(dish),
        dish_revision_id: dishRevisionId(dish),
        unsave_surface: fixture.unsave_surface,
        shortlist_size: Number(fixture.shortlist_size),
      };
      break;
    }

    default:
      throw new Error(`Unsupported synthetic fixture event: ${String(fixture.event_type)}`);
  }

  return ObservationV2Schema.parse({
    ...base,
    payload,
  });
}

const positions = new Map<string, number>();

const canonicalEvents = fixtureEvents.map((event) => toCanonicalFixtureEvent(event, positions));

const storage = new FakeR2ArchiveStorage();

const consumer = new QueueConsumer({
  r2Storage: storage,
  repository: new PostgresObservationRepository(client),
});

beforeAll(async () => {
  await admin.connect();
  await client.connect();

  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
    tenantId,
    'Owner synthetic P0 v2 integration test',
  ]);
});

afterAll(async () => {
  await client.end();
  await admin.end();
});

it('ingests, archives, persists and deduplicates the owner synthetic P0 v2 starter fixture', async () => {
  // 1. Validate the source fixture's delivery counts.
  expect(fixtureEvents).toHaveLength(22);
  expect(canonicalEvents).toHaveLength(22);

  const uniqueEventIds = new Set(canonicalEvents.map((event) => event.event_id));

  expect(uniqueEventIds.size).toBe(21);

  // 2. Ingest through the real observation ingestion boundary.
  // Explicit test traffic prevents synthetic events entering owner metrics.
  const messages: unknown[] = [];

  const ingestResult = await ingestObservations(
    canonicalEvents,
    {
      venueId: tenantId,
      publicationId,
      jti: randomUUID(),
      trafficClass: 'test',
    },
    {
      now: () => now,
      enqueue: async (message) => {
        messages.push(message);
      },
    },
  );

  expect(ingestResult.queueUnavailable).toBe(false);
  expect(messages).toHaveLength(21);

  if (ingestResult.queueUnavailable) {
    throw new Error('Observation queue unexpectedly unavailable');
  }

  expect(JSON.stringify(ingestResult.response)).toContain('duplicate_in_batch');

  // 3. Process each unique queue message through the real consumer.
  for (const message of messages) {
    const outcome = await consumer.processMessage(message);

    expect(outcome, outcome.status === 'retry' ? outcome.error.message : '').toEqual({
      status: 'acknowledged',
      reason: 'persisted',
    });
  }

  // 4. Reprocess every message to verify idempotent replay.
  for (const message of messages) {
    expect(await consumer.processMessage(message)).toEqual({
      status: 'acknowledged',
      reason: 'duplicate_same_payload',
    });
  }

  // 5. Verify canonical event persistence and traffic classification.
  const eventResult = await admin.query(
    `SELECT event_type, traffic_class
       FROM app_private.observation_event
       WHERE tenant_id = $1
       ORDER BY event_type`,
    [tenantId],
  );

  expect(eventResult.rowCount).toBe(21);
  expect(eventResult.rows.every((row) => row.traffic_class === 'test')).toBe(true);

  const eventCounts = await admin.query(
    `SELECT event_type, count(*)::int AS count
       FROM app_private.observation_event
       WHERE tenant_id = $1
       GROUP BY event_type
       ORDER BY event_type`,
    [tenantId],
  );

  expect(Object.fromEntries(eventCounts.rows.map((row) => [row.event_type, row.count]))).toEqual({
    dish_activity_checkpoint: 3,
    dish_compared: 2,
    dish_detail_opened: 2,
    dish_saved: 4,
    dish_unsaved: 3,
    dish_viewed: 5,
    menu_viewed: 2,
  });

  // 6. Verify typed fact persistence.
  const expectedFacts: Record<string, number> = {
    menu_view: 2,
    exposure: 5,
    opening: 2,
    activity: 3,
    comparison: 2,
    save: 7,
    closing: 0,
    shortlist_view: 0,
  };

  for (const [table, expectedCount] of Object.entries(expectedFacts)) {
    const result = await admin.query(
      `SELECT count(*)::int AS count
         FROM app_private.observation_${table}
         WHERE tenant_id = $1`,
      [tenantId],
    );

    expect(result.rows[0].count, `Unexpected ${table} fact count`).toBe(expectedCount);
  }

  // 7. Verify that every accepted observation has an archived payload
  // whose checksum matches the canonical observation index.
  const indexResult = await admin.query(
    `SELECT event_id, r2_archive_key, canonical_payload_checksum
       FROM app_private.observation_index
       WHERE tenant_id = $1
         AND disposition = 'accepted'`,
    [tenantId],
  );

  expect(indexResult.rowCount).toBe(21);
  expect([...storage.keys()]).toHaveLength(21);

  for (const row of indexResult.rows) {
    expect(storage.has(row.r2_archive_key)).toBe(true);

    const archived = await storage.getRawPayload(row.r2_archive_key);

    expect(archived).not.toBeNull();

    if (!archived) {
      throw new Error(`Missing archived payload: ${row.r2_archive_key}`);
    }

    const archivedEnvelope = JSON.parse(new TextDecoder().decode(archived.rawBytes)) as Parameters<
      typeof toCanonicalObservation
    >[0];

    const archivedCanonical = toCanonicalObservation(archivedEnvelope);

    expect(await sha256Hex(canonicalJson(archivedCanonical))).toBe(row.canonical_payload_checksum);

    expect(archived.checksum).toBe(row.canonical_payload_checksum);
    expect(archived.rawBytes.length).toBeGreaterThan(0);
  }

  // 8. Verify that test traffic never enters the owner observation view.
  const ownerResult = await admin.query(
    `SELECT *
       FROM app_private.owner_observation_v1
       WHERE tenant_id = $1`,
    [tenantId],
  );

  expect(ownerResult.rowCount).toBe(0);
});

import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readComparisonReport } from './comparison-report';

const admin = new Client({ connectionString: process.env.PEEKAPLATE_DB_ADMIN_URL });
const runtime = new Client({ connectionString: process.env.PEEKAPLATE_DB_TEST_URL });
const actorId = crypto.randomUUID();
const venueId = crypto.randomUUID();
const dishId = crypto.randomUUID();
const dishRevisionId = crypto.randomUUID();
const otherDishId = crypto.randomUUID();
const otherDishRevisionId = crypto.randomUUID();
const publicationId = crypto.randomUUID();

beforeAll(async () => {
  await admin.connect();
  await runtime.connect();
  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
    venueId,
    'Synthetic comparison report test',
  ]);
  await admin.query(
    "INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, 'viewer')",
    [venueId, actorId],
  );
  await admin.query(
    `INSERT INTO app_private.dish_current (tenant_id, dish_id, version, revision_id, name, description)
     VALUES ($1, $2, 1, $3, 'Comparison fixture', '')`,
    [venueId, dishId, dishRevisionId],
  );
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

async function insertFact(
  eventType: string,
  sessionId: string,
  occurredAt: string,
  fields: Record<string, unknown>,
) {
  const eventId = crypto.randomUUID();
  await admin.query(
    `INSERT INTO app_private.observation_index
       (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type,
        authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition)
     VALUES ($1, $2, $3, 'observation.v2', $4, $5, $6, $6, $7, 'accepted')`,
    [
      venueId,
      eventId,
      'a'.repeat(64),
      eventType,
      publicationId,
      occurredAt,
      `comparison-fixture/${eventId}`,
    ],
  );
  await admin.query(
    `INSERT INTO app_private.observation_event
       (tenant_id, event_id, event_type, session_id, producer_id, local_sequence,
        publication_revision_id, traffic_class)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 'live')`,
    [venueId, eventId, eventType, sessionId, crypto.randomUUID(), publicationId],
  );

  if (eventType === 'dish_viewed') {
    await admin.query(
      `INSERT INTO app_private.observation_exposure
         (tenant_id, event_id, dish_id, dish_revision_id, exposure_id, surface, position, exposure_basis)
       VALUES ($1, $2, $3, $4, $5, 'menu_list', 1, 'viewport_50pct_1s')`,
      [venueId, eventId, dishId, dishRevisionId, fields.exposureId],
    );
  } else if (eventType === 'dish_detail_opened') {
    await admin.query(
      `INSERT INTO app_private.observation_opening
         (tenant_id, event_id, dish_id, dish_revision_id, opening_id, source, save_available)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [venueId, eventId, dishId, dishRevisionId, fields.openingId, fields.source],
    );
  } else if (eventType === 'dish_activity_checkpoint') {
    await admin.query(
      `INSERT INTO app_private.observation_activity
         (tenant_id, event_id, dish_id, dish_revision_id, opening_id, active_ms, final)
       VALUES ($1, $2, $3, $4, $5, 12000, true)`,
      [venueId, eventId, dishId, dishRevisionId, fields.openingId],
    );
  } else if (eventType === 'dish_compared') {
    await admin.query(
      `INSERT INTO app_private.observation_comparison
         (tenant_id, event_id, dish_id, dish_revision_id, other_dish_id,
          other_dish_revision_id, comparison_id, compare_action, save_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'start', true)`,
      [
        venueId,
        eventId,
        dishId,
        dishRevisionId,
        otherDishId,
        otherDishRevisionId,
        fields.comparisonId,
      ],
    );
  } else if (eventType === 'dish_saved') {
    await admin.query(
      `INSERT INTO app_private.observation_save
         (tenant_id, event_id, event_type, dish_id, dish_revision_id, save_origin, surface, shortlist_size)
       VALUES ($1, $2, 'dish_saved', $3, $4, 'direct', 'menu_card', 1)`,
      [venueId, eventId, dishId, dishRevisionId],
    );
  }
}

async function seedPeriod(start: string, period: 'current' | 'baseline') {
  const openings = period === 'current' ? 12 : 10;
  const timedOpenings = period === 'current' ? new Set([0, 1]) : new Set([0]);
  const comparedOpenings = period === 'current' ? new Set([2, 3]) : new Set([1]);
  const saves = period === 'current' ? new Set([0, 1]) : new Set([0]);

  for (let index = 0; index < 20; index += 1) {
    const sessionId = crypto.randomUUID();
    const occurredAt = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
    await insertFact('dish_viewed', sessionId, occurredAt, {
      exposureId: crypto.randomUUID(),
    });

    if (index < openings) {
      const openingId = crypto.randomUUID();
      await insertFact('dish_detail_opened', sessionId, occurredAt, {
        openingId,
        source: comparedOpenings.has(index) ? 'compare_view' : 'menu_card',
      });
      if (timedOpenings.has(index)) {
        await insertFact('dish_activity_checkpoint', sessionId, occurredAt, { openingId });
      }
      if (comparedOpenings.has(index)) {
        await insertFact('dish_compared', sessionId, occurredAt, {
          comparisonId: crypto.randomUUID(),
        });
      }
      if (saves.has(index)) await insertFact('dish_saved', sessionId, occurredAt, {});
    }
  }
}

it('aggregates unique sessions from migrated tenant-scoped facts into the report', async () => {
  await seedPeriod('2026-10-28T00:00:00Z', 'current');
  await seedPeriod('2026-10-21T00:00:00Z', 'baseline');
  const crossWindowSession = crypto.randomUUID();
  const previousWindowOpening = crypto.randomUUID();
  await insertFact('dish_detail_opened', crossWindowSession, '2026-10-25T12:00:00Z', {
    openingId: previousWindowOpening,
    source: 'menu_card',
  });
  await insertFact('dish_activity_checkpoint', crossWindowSession, '2026-10-28T12:00:00Z', {
    openingId: previousWindowOpening,
  });
  await insertFact('dish_detail_opened', crossWindowSession, '2026-10-28T12:00:00Z', {
    openingId: crypto.randomUUID(),
    source: 'menu_card',
  });

  const report = await readComparisonReport(
    runtime,
    actorId,
    venueId,
    '2026-10-26T00:00:00Z',
    '2026-11-02T00:00:00Z',
    '2026-10-19T00:00:00Z',
    '2026-10-26T00:00:00Z',
  );

  expect(report).toMatchObject({
    schema_version: 'comparison_report.v1',
    venue_id: venueId,
    comparison_eligibility: 'COMPARABLE',
    dishes: [
      {
        dish_id: dishId,
        name: 'Comparison fixture',
        comparison_status: 'COMPARABLE',
        metrics: {
          open_rate: {
            status: 'COMPARABLE',
            eligible_sessions: 20,
          },
          engagement_rate: {
            status: 'COMPARABLE',
            eligible_sessions: 11,
          },
          save_rate: {
            status: 'COMPARABLE',
            eligible_sessions: 20,
          },
        },
      },
    ],
  });
  const metrics = report.dishes[0]!.metrics;
  expect(metrics.open_rate.current_value).toBeCloseTo(0.6);
  expect(metrics.open_rate.baseline_value).toBeCloseTo(0.5);
  expect(metrics.open_rate.delta).toBeCloseTo(0.1);
  expect(metrics.engagement_rate.current_value).toBeCloseTo(4 / 13);
  expect(metrics.engagement_rate.baseline_value).toBeCloseTo(2 / 11);
  expect(metrics.engagement_rate.delta).toBeCloseTo(4 / 13 - 2 / 11);
  expect(metrics.save_rate.current_value).toBeCloseTo(0.1);
  expect(metrics.save_rate.baseline_value).toBeCloseTo(0.05);
  expect(metrics.save_rate.delta).toBeCloseTo(0.05);
});

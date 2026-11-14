import { OwnerDishReportSchema } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import revisionCases from '../../tests/data05/comparison_revision_cases.json';
import { readComparisonReport } from './comparison-report';
import { readOwnerReport } from './owner-report';

const admin = new Client({ connectionString: process.env.PEEKAPLATE_DB_ADMIN_URL });
const runtime = new Client({ connectionString: process.env.PEEKAPLATE_DB_TEST_URL });
const actorId = crypto.randomUUID();
const venueId = crypto.randomUUID();
const dishId = crypto.randomUUID();
const dishRevisionId = crypto.randomUUID();
const otherDishId = crypto.randomUUID();
const otherDishRevisionId = crypto.randomUUID();
const publicationId = crypto.randomUUID();
const producers = new Map<string, { id: string; sequence: number }>();

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
  const backgroundVenue = crypto.randomUUID();
  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
    backgroundVenue,
    'Synthetic unrelated comparison traffic',
  ]);
  await admin.query(
    `WITH fixture AS MATERIALIZED (
       SELECT gen_random_uuid() AS event_id FROM generate_series(1, 1000)
     ), indexed AS (
       INSERT INTO app_private.observation_index
         (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type,
          authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition)
       SELECT $1, event_id, repeat('a', 64), 'observation.v2', 'dish_viewed',
         $2, '2026-10-27T01:00:00Z', '2026-10-27T01:00:00Z',
         'comparison-background/' || event_id, 'accepted' FROM fixture
       RETURNING event_id
     )
     INSERT INTO app_private.observation_event
       (tenant_id, event_id, event_type, session_id, producer_id, local_sequence,
        publication_revision_id, traffic_class)
     SELECT $1, event_id, 'dish_viewed', gen_random_uuid(), gen_random_uuid(), 0, $2, 'live'
     FROM indexed`,
    [backgroundVenue, publicationId],
  );
  await admin.query(
    `INSERT INTO app_private.observation_exposure
       (tenant_id, event_id, dish_id, dish_revision_id, exposure_id, surface, position, exposure_basis)
     SELECT tenant_id, event_id, $2, $3, gen_random_uuid(), 'menu_list', 1, 'viewport_50pct_1s'
     FROM app_private.observation_event WHERE tenant_id = $1`,
    [backgroundVenue, dishId, dishRevisionId],
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
  const producer = producers.get(sessionId) ?? { id: crypto.randomUUID(), sequence: 0 };
  producers.set(sessionId, producer);
  const publication = fields.publicationId ?? publicationId;
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
      publication,
      occurredAt,
      `comparison-fixture/${eventId}`,
    ],
  );
  await admin.query(
    `INSERT INTO app_private.observation_event
       (tenant_id, event_id, event_type, session_id, producer_id, local_sequence,
        publication_revision_id, traffic_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      venueId,
      eventId,
      eventType,
      sessionId,
      producer.id,
      producer.sequence++,
      publication,
      fields.trafficClass ?? 'live',
    ],
  );

  if (eventType === 'dish_viewed') {
    await admin.query(
      `INSERT INTO app_private.observation_exposure
         (tenant_id, event_id, dish_id, dish_revision_id, exposure_id, surface, position, exposure_basis)
       VALUES ($1, $2, $3, $4, $5, 'menu_list', 1, 'viewport_50pct_1s')`,
      [venueId, eventId, dishId, fields.dishRevisionId ?? dishRevisionId, fields.exposureId],
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

async function readDay(day: string) {
  const end = new Date(Date.parse(day) + 24 * 60 * 60 * 1000).toISOString();
  return readComparisonReport(runtime, actorId, venueId, day, end, day, end);
}

it('cannot reconstruct a suppressed opened cohort from rates and exposure counts', async () => {
  const day = '2026-12-01T00:00:00Z';
  for (let index = 0; index < 10; index++) {
    const sessionId = crypto.randomUUID();
    await insertFact('dish_viewed', sessionId, day, { exposureId: crypto.randomUUID() });
    if (index === 0) {
      await insertFact('dish_detail_opened', sessionId, day, {
        openingId: crypto.randomUUID(),
        source: 'menu_card',
      });
    }
  }
  const metrics = (await readDay(day)).dishes[0]!.metrics;
  expect(metrics.engagement_rate.status).toBe('INSUFFICIENT');
  expect(metrics.open_rate).toMatchObject({
    status: 'INSUFFICIENT',
    current_value: null,
    baseline_value: null,
    delta: null,
    eligible_sessions: null,
  });
});

it('qualifies a prior menu-card opening followed by a displayed comparison', async () => {
  const day = '2026-12-02T00:00:00Z';
  for (let index = 0; index < 10; index++) {
    const sessionId = crypto.randomUUID();
    await insertFact('dish_viewed', sessionId, day, { exposureId: crypto.randomUUID() });
    await insertFact('dish_detail_opened', sessionId, day, {
      openingId: crypto.randomUUID(),
      source: 'menu_card',
    });
    await insertFact('dish_compared', sessionId, day, { comparisonId: crypto.randomUUID() });
  }
  expect((await readDay(day)).dishes[0]!.metrics.engagement_rate).toMatchObject({
    status: 'COMPARABLE',
    current_value: 1,
    baseline_value: 1,
    delta: 0,
    eligible_sessions: 10,
  });
});

it.each([0, 9, 10, 11])(
  'applies complementary suppression for %i current opened sessions',
  async (opened) => {
    const current = new Date(Date.UTC(2027, 0, 1 + opened * 3)).toISOString();
    const baseline = new Date(Date.parse(current) - 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.parse(current) + 24 * 60 * 60 * 1000).toISOString();
    for (const [day, count] of [
      [current, opened],
      [baseline, 10],
    ] as const) {
      for (let index = 0; index < 12; index++) {
        const session = crypto.randomUUID();
        await insertFact('dish_viewed', session, day, { exposureId: crypto.randomUUID() });
        if (index < count)
          await insertFact('dish_detail_opened', session, day, {
            openingId: crypto.randomUUID(),
            source: 'menu_card',
          });
      }
    }
    const metric = (
      await readComparisonReport(runtime, actorId, venueId, current, end, baseline, current)
    ).dishes[0]!.metrics.open_rate;
    if (opened > 0 && opened < 10) {
      expect(metric).toMatchObject({
        status: 'INSUFFICIENT',
        current_value: null,
        baseline_value: null,
        delta: null,
        eligible_sessions: null,
      });
    } else {
      expect(metric.current_value).toBeCloseTo(opened / 12);
      expect(metric.baseline_value).toBeCloseTo(10 / 12);
      expect(metric.delta).toBeCloseTo((opened - 10) / 12);
      expect(metric.eligible_sessions).toBe(12);
    }
  },
);

it('does not qualify a comparison displayed before any opening', async () => {
  const day = '2026-12-03T00:00:00Z';
  for (let index = 0; index < 10; index++) {
    const session = crypto.randomUUID();
    await insertFact('dish_viewed', session, day, { exposureId: crypto.randomUUID() });
    await insertFact('dish_compared', session, day, { comparisonId: crypto.randomUUID() });
    await insertFact('dish_detail_opened', session, day, {
      openingId: crypto.randomUUID(),
      source: 'compare_view',
    });
  }
  expect((await readDay(day)).dishes[0]!.metrics.engagement_rate).toMatchObject({
    status: 'VALID_ZERO',
    current_value: 0,
    baseline_value: 0,
    delta: 0,
  });
});

it('executes the restored cross-publication fixture with seventeen distinct sessions', async () => {
  const day = '2026-12-04T00:00:00Z';
  const scenario = revisionCases.cases[0]!;
  const identities = new Map<string, string>();
  for (const labels of [
    scenario.input.revision_A_session_ids,
    scenario.input.revision_B_session_ids,
  ]) {
    const publication = crypto.randomUUID();
    const revision = crypto.randomUUID();
    for (const label of labels) {
      const session = identities.get(label) ?? crypto.randomUUID();
      identities.set(label, session);
      await insertFact('dish_viewed', session, day, {
        publicationId: publication,
        dishRevisionId: revision,
        exposureId: crypto.randomUUID(),
      });
    }
  }
  expect((await readDay(day)).dishes[0]!.metrics.open_rate).toMatchObject({
    status: 'VALID_ZERO',
    current_value: 0,
    baseline_value: 0,
    eligible_sessions: scenario.expected.combined_distinct_sessions,
  });
});

it('excludes test/demo traffic from the live comparison cohorts', async () => {
  const day = '2026-12-05T00:00:00Z';
  for (const traffic of ['live', 'test', 'demo']) {
    for (let index = 0; index < 9; index++) {
      await insertFact('dish_viewed', crypto.randomUUID(), day, {
        exposureId: crypto.randomUUID(),
        trafficClass: traffic,
      });
    }
  }
  for (const metric of Object.values((await readDay(day)).dishes[0]!.metrics)) {
    expect(metric).toMatchObject({
      status: 'INSUFFICIENT',
      current_value: null,
      baseline_value: null,
      delta: null,
      eligible_sessions: null,
    });
  }
});

it('denies a venue without current membership and permits the next authorized read', async () => {
  const day = '2026-12-04T00:00:00Z';
  const end = '2026-12-05T00:00:00Z';
  await expect(
    readComparisonReport(runtime, actorId, crypto.randomUUID(), day, end, day, end),
  ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  expect((await readDay(day)).venue_id).toBe(venueId);
});

it('uses a start-inclusive, end-exclusive owner-report window for exposures', async () => {
  const start = '2035-02-01T00:00:00.000Z';
  const end = new Date('2035-02-02T00:00:00.000Z');
  const ownerId = crypto.randomUUID();
  await admin.query(
    "INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, 'owner')",
    [venueId, ownerId],
  );
  for (let index = 0; index < 10; index++) {
    await insertFact('dish_viewed', crypto.randomUUID(), start, {
      exposureId: crypto.randomUUID(),
    });
  }
  for (const outside of ['2035-01-31T23:59:59.999Z', end.toISOString()]) {
    await insertFact('dish_viewed', crypto.randomUUID(), outside, {
      exposureId: crypto.randomUUID(),
    });
  }
  const report = OwnerDishReportSchema.parse(
    await readOwnerReport(runtime, ownerId, venueId, end, 'synthetic'),
  );
  expect(report.dishes[0]!.metrics.active_sessions).toEqual({ value: 10, status: 'NORMAL' });
  expect(report.report_metadata.date_window).toMatchObject({
    start_time: start,
    end_time: end.toISOString(),
  });
  expect(report.report_metadata.freshness.is_stale).toBeNull();
});

it('excludes a final checkpoint at the owner-report window end until the next instant', async () => {
  const openingTime = '2035-02-03T12:00:00.000Z';
  const end = new Date('2035-02-04T00:00:00.000Z');
  const ownerId = crypto.randomUUID();
  await admin.query(
    "INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, 'owner')",
    [venueId, ownerId],
  );
  for (let index = 0; index < 11; index++) {
    const sessionId = crypto.randomUUID();
    const openingId = crypto.randomUUID();
    await insertFact('dish_viewed', sessionId, openingTime, { exposureId: crypto.randomUUID() });
    await insertFact('dish_detail_opened', sessionId, openingTime, { openingId, source: 'direct' });
    await insertFact(
      'dish_activity_checkpoint',
      sessionId,
      index === 10 ? end.toISOString() : '2035-02-03T23:59:59.999Z',
      { openingId },
    );
  }
  const report = OwnerDishReportSchema.parse(
    await readOwnerReport(runtime, ownerId, venueId, end, 'synthetic'),
  );
  expect(report.dishes[0]!.metrics.timing_coverage).toEqual({ value: 0.909, status: 'NORMAL' });
  const next = OwnerDishReportSchema.parse(
    await readOwnerReport(runtime, ownerId, venueId, new Date(end.getTime() + 1), 'synthetic'),
  );
  expect(next.dishes[0]!.metrics.timing_coverage).toEqual({ value: 1, status: 'NORMAL' });
});

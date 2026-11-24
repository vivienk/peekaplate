import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type ObservationQueueMessage,
  ObservationV2Schema,
  OwnerDishReportSchema,
} from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresObservationRepository } from './consumer/database';
import { QueueConsumer } from './consumer/queue-consumer';
import { FakeR2ArchiveStorage } from './consumer/r2-storage';
import { ingestObservations } from './observation-ingest';
import { readOwnerReport } from './owner-report';

const admin = new Client({ connectionString: process.env.PEEKAPLATE_DB_ADMIN_URL });
const runtime = new Client({ connectionString: process.env.PEEKAPLATE_DB_TEST_URL });
const createdVenues: string[] = [];

beforeAll(async () => {
  await admin.connect();
  await runtime.connect();
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

async function createVenueFixture(name: string) {
  const venueId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const dishId = crypto.randomUUID();
  const dishRevisionId = crypto.randomUUID();
  const publicationId = crypto.randomUUID();
  createdVenues.push(venueId);

  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [venueId, name]);
  await admin.query(
    "INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, 'owner')",
    [venueId, ownerId],
  );
  await admin.query(
    `INSERT INTO app_private.dish_current (tenant_id, dish_id, version, revision_id, name, description)
     VALUES ($1, $2, 1, $3, $4, '')`,
    [venueId, dishId, dishRevisionId, name],
  );

  let sequence = 0;
  const defaultProducerId = crypto.randomUUID();

  async function insertEvent(
    eventType: string,
    sessionId: string,
    occurredAt: string,
    options: {
      producerId?: string;
      localSequence?: number;
      trafficClass?: 'live' | 'test' | 'demo';
    } = {},
  ) {
    const eventId = crypto.randomUUID();
    const producerId = options.producerId ?? defaultProducerId;
    const localSequence = options.localSequence ?? ++sequence;
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
        `owner-report-int/${venueId}/${eventId}`,
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
        producerId,
        localSequence,
        publicationId,
        options.trafficClass ?? 'live',
      ],
    );
    return eventId;
  }

  async function addExposure(sessionId: string, occurredAt: string) {
    const eventId = await insertEvent('dish_viewed', sessionId, occurredAt);
    const exposureId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO app_private.observation_exposure
         (tenant_id, event_id, dish_id, dish_revision_id, exposure_id, surface, position, exposure_basis)
       VALUES ($1, $2, $3, $4, $5, 'menu_list', 1, 'viewport_50pct_1s')`,
      [venueId, eventId, dishId, dishRevisionId, exposureId],
    );
    return exposureId;
  }

  async function addOpening(
    sessionId: string,
    occurredAt: string,
    options: {
      fromExposureId?: string | null;
      producerId?: string;
      localSequence?: number;
      openingId?: string;
    } = {},
  ) {
    const openingId = options.openingId ?? crypto.randomUUID();
    const eventId = await insertEvent('dish_detail_opened', sessionId, occurredAt, {
      ...(options.producerId !== undefined ? { producerId: options.producerId } : {}),
      ...(options.localSequence !== undefined ? { localSequence: options.localSequence } : {}),
    });
    const source = options.fromExposureId ? 'menu_card' : 'direct';
    await admin.query(
      `INSERT INTO app_private.observation_opening
         (tenant_id, event_id, dish_id, dish_revision_id, opening_id, source, from_exposure_id, save_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [venueId, eventId, dishId, dishRevisionId, openingId, source, options.fromExposureId ?? null],
    );
    return openingId;
  }

  async function addCheckpoint(
    sessionId: string,
    openingId: string,
    occurredAt: string,
    activeMs: number,
    final: boolean,
  ) {
    const eventId = await insertEvent('dish_activity_checkpoint', sessionId, occurredAt);
    await admin.query(
      `INSERT INTO app_private.observation_activity
         (tenant_id, event_id, dish_id, dish_revision_id, opening_id, active_ms, final)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [venueId, eventId, dishId, dishRevisionId, openingId, activeMs, final],
    );
  }

  async function addComparison(
    sessionId: string,
    occurredAt: string,
    options: { producerId?: string; localSequence?: number } = {},
  ) {
    const eventId = await insertEvent('dish_compared', sessionId, occurredAt, options);
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
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ],
    );
  }

  async function addSave(
    sessionId: string,
    occurredAt: string,
    eventType: 'dish_saved' | 'dish_unsaved',
    saveOrigin: 'direct' | 'undo' | null,
  ) {
    const eventId = await insertEvent(eventType, sessionId, occurredAt);
    await admin.query(
      `INSERT INTO app_private.observation_save
         (tenant_id, event_id, event_type, dish_id, dish_revision_id, save_origin, surface, shortlist_size)
       VALUES ($1, $2, $3, $4, $5, $6, 'dish_detail', 1)`,
      [venueId, eventId, eventType, dishId, dishRevisionId, saveOrigin],
    );
  }

  return {
    venueId,
    ownerId,
    dishId,
    dishRevisionId,
    publicationId,
    addExposure,
    addOpening,
    addCheckpoint,
    addComparison,
    addSave,
  };
}

describe('DATA-17 real PostgreSQL readOwnerReport() verification', () => {
  it('computes exact S7-DATA-17 acceptance scenario metrics against PostgreSQL', async () => {
    const fx = await createVenueFixture('DATA-17 acceptance dish');
    const now = new Date('2035-03-02T00:00:00.000Z');
    const t = '2035-03-01T12:00:00.000Z';

    const sessions = Array.from({ length: 14 }, () => crypto.randomUUID());
    for (let i = 0; i < 14; i++) {
      const sessionId = sessions[i]!;
      const exposureId = await fx.addExposure(sessionId, t);
      if (i < 10) {
        const openingId = await fx.addOpening(sessionId, t, { fromExposureId: exposureId });
        await fx.addCheckpoint(sessionId, openingId, t, 12_000, true);
      }
      if (i < 3) {
        await fx.addSave(sessionId, t, 'dish_saved', 'direct');
      }
    }
    // 11th opening on an already-opened visit with only a nonfinal checkpoint.
    const extraOpeningId = await fx.addOpening(sessions[0]!, '2035-03-01T12:05:00.000Z');
    await fx.addCheckpoint(sessions[0]!, extraOpeningId, '2035-03-01T12:05:05.000Z', 5_000, false);
    // One of the 3 direct saves is subsequently undone.
    await fx.addSave(sessions[0]!, '2035-03-01T12:06:00.000Z', 'dish_unsaved', null);

    // Verify underlying opening event and unique opened session counts in PostgreSQL.
    const rawCounts = await admin.query<{ opening_events: string; unique_opened_visits: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'dish_detail_opened')::text AS opening_events,
         COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'dish_detail_opened')::text AS unique_opened_visits
       FROM app_private.owner_observation_v1
       WHERE tenant_id = $1 AND dish_id = $2`,
      [fx.venueId, fx.dishId],
    );
    expect(Number(rawCounts.rows[0]!.opening_events)).toBe(11);
    expect(Number(rawCounts.rows[0]!.unique_opened_visits)).toBe(10);

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx.ownerId, fx.venueId, now, 'synthetic'),
    );
    const dish = report.dishes[0]!;
    expect(dish.evidence_state).toBe('NORMAL');
    expect(dish.metrics.active_sessions).toEqual({ value: 14, status: 'NORMAL' });
    expect(dish.metrics.open_rate).toEqual({ value: 0.714, status: 'NORMAL' });
    expect(dish.metrics.timing_coverage).toEqual({ value: 0.909, status: 'NORMAL' });
    expect(dish.metrics.avg_interaction_time_seconds).toEqual({ value: 12, status: 'NORMAL' });
    expect(dish.metrics.save_rate).toEqual({ value: 0.214, status: 'NORMAL' });
    expect(dish.metrics.engagement_rate).toEqual({ value: 1, status: 'NORMAL' });
  });

  it('prevents duplicate ingestion from inflating event counts or metric numerators', async () => {
    const fx = await createVenueFixture('DATA-17 duplicate idempotency');
    const now = new Date('2035-03-04T00:00:00.000Z');
    const occurredAt = '2035-03-03T12:00:00.000Z';
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../packages/contracts/fixtures/observation.v2/fixtures.json', import.meta.url)
            .href,
        ),
        'utf8',
      ),
    );
    const templates = fixture.valid_events as Array<Record<string, unknown>>;
    const viewedTemplate = templates.find((e) => e.type === 'dish_viewed')!;
    const openedTemplate = templates.find((e) => e.type === 'dish_detail_opened')!;
    const activityTemplate = templates.find((e) => e.type === 'dish_activity_checkpoint')!;

    const producerId = crypto.randomUUID();
    let seq = 0;
    const rawEvents: unknown[] = [];

    for (let i = 0; i < 10; i++) {
      const sessionId = crypto.randomUUID();
      const exposureId = crypto.randomUUID();
      const openingId = crypto.randomUUID();
      rawEvents.push(
        ObservationV2Schema.parse({
          ...viewedTemplate,
          event_id: crypto.randomUUID(),
          session_id: sessionId,
          producer_id: producerId,
          local_sequence: ++seq,
          publication_revision_id: fx.publicationId,
          occurred_at: occurredAt,
          payload: {
            ...(viewedTemplate.payload as Record<string, unknown>),
            dish_id: fx.dishId,
            dish_revision_id: fx.dishRevisionId,
            exposure_id: exposureId,
          },
        }),
        ObservationV2Schema.parse({
          ...openedTemplate,
          event_id: crypto.randomUUID(),
          session_id: sessionId,
          producer_id: producerId,
          local_sequence: ++seq,
          publication_revision_id: fx.publicationId,
          occurred_at: occurredAt,
          payload: {
            ...(openedTemplate.payload as Record<string, unknown>),
            dish_id: fx.dishId,
            dish_revision_id: fx.dishRevisionId,
            opening_id: openingId,
            source: 'menu_card',
            from_exposure_id: exposureId,
          },
        }),
        ObservationV2Schema.parse({
          ...activityTemplate,
          event_id: crypto.randomUUID(),
          session_id: sessionId,
          producer_id: producerId,
          local_sequence: ++seq,
          publication_revision_id: fx.publicationId,
          occurred_at: occurredAt,
          payload: {
            ...(activityTemplate.payload as Record<string, unknown>),
            dish_id: fx.dishId,
            dish_revision_id: fx.dishRevisionId,
            opening_id: openingId,
            active_ms: 12_000,
            final: true,
          },
        }),
      );
    }

    const storage = new FakeR2ArchiveStorage();
    const consumer = new QueueConsumer({
      r2Storage: storage,
      repository: new PostgresObservationRepository(runtime),
    });

    const enqueueAndConsume = async (events: unknown[]) => {
      const responses = [];
      for (let i = 0; i < events.length; i += 20) {
        const batch = events.slice(i, i + 20);
        const messages: ObservationQueueMessage[] = [];
        const res = await ingestObservations(
          batch,
          {
            venueId: fx.venueId,
            publicationId: fx.publicationId,
            jti: crypto.randomUUID(),
            trafficClass: 'live',
          },
          {
            now: () => new Date(occurredAt),
            enqueue: async (envelope) => {
              if (envelope.kind === 'observation.v2') messages.push(envelope);
            },
          },
        );
        for (const message of messages) {
          await consumer.processMessage(message);
        }
        if (res.queueUnavailable) throw new Error('Unexpected queueUnavailable');
        responses.push(res.response);
      }
      return responses;
    };

    // First ingestion + in-batch duplicate, followed by full redelivery.
    const first = await enqueueAndConsume([rawEvents[0], ...rawEvents]);
    expect(JSON.stringify(first)).toContain('duplicate_in_batch');
    await enqueueAndConsume(rawEvents);

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx.ownerId, fx.venueId, now, 'synthetic'),
    );
    expect(report.dishes[0]!.metrics).toMatchObject({
      active_sessions: { value: 10, status: 'NORMAL' },
      open_rate: { value: 1, status: 'NORMAL' },
      timing_coverage: { value: 1, status: 'NORMAL' },
      avg_interaction_time_seconds: { value: 12, status: 'NORMAL' },
    });
  });

  it('counts repeated openings within a visit once per session for rates and per opening for timing', async () => {
    const fx = await createVenueFixture('DATA-17 repeated openings');
    const now = new Date('2035-03-06T00:00:00.000Z');
    const t = '2035-03-05T12:00:00.000Z';

    const sessions = Array.from({ length: 10 }, () => crypto.randomUUID());
    for (let i = 0; i < 10; i++) {
      const sessionId = sessions[i]!;
      const expId = await fx.addExposure(sessionId, t);
      const openId = await fx.addOpening(sessionId, t, { fromExposureId: expId });
      await fx.addCheckpoint(sessionId, openId, t, 10_000, true);
    }
    // Session 0 opens twice more: one finalized (22s), one uncheckpointed.
    const repeatFinal = await fx.addOpening(sessions[0]!, '2035-03-05T12:01:00.000Z');
    await fx.addCheckpoint(sessions[0]!, repeatFinal, '2035-03-05T12:01:22.000Z', 22_000, true);
    await fx.addOpening(sessions[0]!, '2035-03-05T12:02:00.000Z');

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx.ownerId, fx.venueId, now, 'synthetic'),
    );
    const m = report.dishes[0]!.metrics;
    expect(m.active_sessions).toEqual({ value: 10, status: 'NORMAL' });
    expect(m.open_rate).toEqual({ value: 1, status: 'NORMAL' });
    // 11 finalized openings / 12 total openings = 0.917
    expect(m.timing_coverage).toEqual({ value: 0.917, status: 'NORMAL' });
    // (10 * 10 + 22) / 11 = 11.0909...
    expect(m.avg_interaction_time_seconds.status).toBe('NORMAL');
    expect(m.avg_interaction_time_seconds.value).toBeCloseTo(122 / 11, 4);
  });

  it('orders equal timestamps deterministically by producer_id and local_sequence', async () => {
    const fx = await createVenueFixture('DATA-17 equal timestamps');
    const now = new Date('2035-03-08T00:00:00.000Z');
    const t = '2035-03-07T12:00:00.000Z';
    const producerA = crypto.randomUUID();
    const producerB = crypto.randomUUID();

    for (let i = 0; i < 10; i++) {
      const sessionId = crypto.randomUUID();
      const expId = await fx.addExposure(sessionId, t);
      if (i === 0) {
        // Same producer, opened seq 1 < compared seq 2 -> qualifies.
        const openId = await fx.addOpening(sessionId, t, {
          fromExposureId: expId,
          producerId: producerA,
          localSequence: 1,
        });
        await fx.addCheckpoint(sessionId, openId, t, 2_000, true);
        await fx.addComparison(sessionId, t, { producerId: producerA, localSequence: 2 });
      } else if (i === 1) {
        // Same producer, compared seq 3 < opened seq 4 -> does NOT qualify.
        await fx.addComparison(sessionId, t, { producerId: producerA, localSequence: 3 });
        const openId = await fx.addOpening(sessionId, t, {
          fromExposureId: expId,
          producerId: producerA,
          localSequence: 4,
        });
        await fx.addCheckpoint(sessionId, openId, t, 2_000, true);
      } else if (i === 2) {
        // Different producer at equal timestamp -> does NOT qualify.
        const openId = await fx.addOpening(sessionId, t, {
          fromExposureId: expId,
          producerId: producerA,
          localSequence: 5,
        });
        await fx.addCheckpoint(sessionId, openId, t, 2_000, true);
        await fx.addComparison(sessionId, t, { producerId: producerB, localSequence: 6 });
      } else {
        const openId = await fx.addOpening(sessionId, t, { fromExposureId: expId });
        await fx.addCheckpoint(sessionId, openId, t, 2_000, true);
      }
    }

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx.ownerId, fx.venueId, now, 'synthetic'),
    );
    expect(report.dishes[0]!.metrics.engagement_rate).toEqual({ value: 0.1, status: 'NORMAL' });
  });

  it('excludes nonfinal checkpoints from finalized timing while enforcing start-inclusive and end-exclusive UTC boundaries', async () => {
    const fx = await createVenueFixture('DATA-17 UTC and nonfinal');
    const start = '2035-03-09T00:00:00.000Z';
    const end = new Date('2035-03-10T00:00:00.000Z');
    const justBeforeEnd = '2035-03-09T23:59:59.999Z';

    // Outside window: 1ms before start and exactly at end -> excluded.
    await fx.addExposure(crypto.randomUUID(), '2035-03-08T23:59:59.999Z');
    await fx.addExposure(crypto.randomUUID(), end.toISOString());

    for (let i = 0; i < 10; i++) {
      const sessionId = crypto.randomUUID();
      const ts = i === 0 ? start : justBeforeEnd;
      const expId = await fx.addExposure(sessionId, ts);
      const openId = await fx.addOpening(sessionId, ts, { fromExposureId: expId });
      await fx.addCheckpoint(sessionId, openId, ts, 12_000, true);
    }
    // 11th opening with a 30s nonfinal checkpoint: must NOT affect average opening time (stays 12s).
    const nonfinalOpenId = await fx.addOpening(crypto.randomUUID(), justBeforeEnd);
    await fx.addCheckpoint(crypto.randomUUID(), nonfinalOpenId, justBeforeEnd, 30_000, false);

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx.ownerId, fx.venueId, end, 'synthetic'),
    );
    expect(report.dishes[0]!.metrics.active_sessions).toEqual({ value: 10, status: 'NORMAL' });
    expect(report.dishes[0]!.metrics.avg_interaction_time_seconds).toEqual({
      value: 12,
      status: 'NORMAL',
    });
    expect(report.dishes[0]!.metrics.timing_coverage).toEqual({ value: 0.909, status: 'NORMAL' });
  });

  it('enforces privacy thresholds at 9, 10, and 11 sessions and independent complementary suppression', async () => {
    const t = '2035-03-11T12:00:00.000Z';
    const now = new Date('2035-03-12T00:00:00.000Z');

    // 9 sessions -> all SUPPRESSED.
    const fx9 = await createVenueFixture('DATA-17 floor 9');
    for (let i = 0; i < 9; i++) {
      const s = crypto.randomUUID();
      const exp = await fx9.addExposure(s, t);
      const op = await fx9.addOpening(s, t, { fromExposureId: exp });
      await fx9.addCheckpoint(s, op, t, 12_000, true);
    }
    const r9 = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx9.ownerId, fx9.venueId, now, 'synthetic'),
    );
    expect(r9.dishes[0]!.evidence_state).toBe('SUPPRESSED');
    for (const cell of Object.values(r9.dishes[0]!.metrics)) {
      expect(cell).toEqual({ value: null, status: 'SUPPRESSED' });
    }

    // 10 sessions -> NORMAL.
    const fx10 = await createVenueFixture('DATA-17 floor 10');
    for (let i = 0; i < 10; i++) {
      const s = crypto.randomUUID();
      const exp = await fx10.addExposure(s, t);
      const op = await fx10.addOpening(s, t, { fromExposureId: exp });
      await fx10.addCheckpoint(s, op, t, 12_000, true);
    }
    const r10 = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx10.ownerId, fx10.venueId, now, 'synthetic'),
    );
    expect(r10.dishes[0]!.evidence_state).toBe('NORMAL');
    expect(r10.dishes[0]!.metrics.active_sessions).toEqual({ value: 10, status: 'NORMAL' });

    // 11 exposed, 10 opened/timed -> NORMAL.
    const fx11 = await createVenueFixture('DATA-17 floor 11');
    for (let i = 0; i < 11; i++) {
      const s = crypto.randomUUID();
      const exp = await fx11.addExposure(s, t);
      if (i < 10) {
        const op = await fx11.addOpening(s, t, { fromExposureId: exp });
        await fx11.addCheckpoint(s, op, t, 12_000, true);
      }
    }
    const r11 = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fx11.ownerId, fx11.venueId, now, 'synthetic'),
    );
    expect(r11.dishes[0]!.metrics.active_sessions).toEqual({ value: 11, status: 'NORMAL' });
    expect(r11.dishes[0]!.metrics.open_rate).toEqual({ value: 0.909, status: 'NORMAL' });

    // Complementary suppression (timing cohort = 9 < 10, opened = 10 >= 10).
    const fxTimingComp = await createVenueFixture('DATA-17 timing comp suppression');
    for (let i = 0; i < 12; i++) {
      const s = crypto.randomUUID();
      const exp = await fxTimingComp.addExposure(s, t);
      if (i < 10) {
        const op = await fxTimingComp.addOpening(s, t, { fromExposureId: exp });
        if (i < 9) await fxTimingComp.addCheckpoint(s, op, t, 12_000, true);
      }
    }
    const rTimingComp = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fxTimingComp.ownerId, fxTimingComp.venueId, now, 'synthetic'),
    );
    expect(rTimingComp.dishes[0]!.metrics.active_sessions).toEqual({
      value: null,
      status: 'SUPPRESSED',
    });
    expect(rTimingComp.dishes[0]!.metrics.avg_interaction_time_seconds).toEqual({
      value: null,
      status: 'SUPPRESSED',
    });
    expect(rTimingComp.dishes[0]!.metrics.timing_coverage).toEqual({
      value: null,
      status: 'SUPPRESSED',
    });
    expect(rTimingComp.dishes[0]!.metrics.open_rate).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(rTimingComp.dishes[0]!.metrics.engagement_rate).toEqual({
      value: 0.9,
      status: 'NORMAL',
    });
    expect(rTimingComp.dishes[0]!.metrics.save_rate).toEqual({ value: 0, status: 'VALID_ZERO' });

    // Complementary suppression (opening cohort = 9 < 10, timed = 0).
    const fxOpenComp = await createVenueFixture('DATA-17 open comp suppression');
    for (let i = 0; i < 12; i++) {
      const s = crypto.randomUUID();
      const exp = await fxOpenComp.addExposure(s, t);
      if (i < 9) {
        await fxOpenComp.addOpening(s, t, { fromExposureId: exp });
      }
    }
    const rOpenComp = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fxOpenComp.ownerId, fxOpenComp.venueId, now, 'synthetic'),
    );
    expect(rOpenComp.dishes[0]!.metrics.active_sessions).toEqual({
      value: null,
      status: 'SUPPRESSED',
    });
    expect(rOpenComp.dishes[0]!.metrics.open_rate).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(rOpenComp.dishes[0]!.metrics.engagement_rate).toEqual({
      value: null,
      status: 'SUPPRESSED',
    });
    expect(rOpenComp.dishes[0]!.metrics.save_rate).toEqual({ value: 0, status: 'VALID_ZERO' });
  });

  it('distinguishes EMPTY, VALID_ZERO, NOT_MEASURABLE, and direct-save-then-undo semantics', async () => {
    const t = '2035-03-13T12:00:00.000Z';
    const now = new Date('2035-03-14T00:00:00.000Z');

    // Empty venue -> EMPTY report.
    const fxEmpty = await createVenueFixture('DATA-17 empty');
    const rEmpty = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fxEmpty.ownerId, fxEmpty.venueId, now, 'synthetic'),
    );
    expect(rEmpty.report_metadata.report_status).toBe('EMPTY');
    expect(rEmpty.dishes).toEqual([]);
    expect(rEmpty.report_metadata.freshness).toEqual({
      is_stale: null,
      last_event_ingested_at: null,
    });

    // 10 exposed, 0 openings, 0 saves -> VALID_ZERO vs NOT_MEASURABLE.
    const fxZero = await createVenueFixture('DATA-17 valid zero vs not measurable');
    for (let i = 0; i < 10; i++) {
      await fxZero.addExposure(crypto.randomUUID(), t);
    }
    const rZero = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fxZero.ownerId, fxZero.venueId, now, 'synthetic'),
    );
    expect(rZero.dishes[0]!.metrics).toEqual({
      active_sessions: { value: 10, status: 'NORMAL' },
      open_rate: { value: 0, status: 'VALID_ZERO' },
      save_rate: { value: 0, status: 'VALID_ZERO' },
      timing_coverage: { value: null, status: 'NOT_MEASURABLE' },
      avg_interaction_time_seconds: { value: null, status: 'NOT_MEASURABLE' },
      engagement_rate: { value: null, status: 'NOT_MEASURABLE' },
    });

    // Direct save followed by undo counts, while save_origin = 'undo' does not count.
    const fxSave = await createVenueFixture('DATA-17 save undo');
    for (let i = 0; i < 10; i++) {
      const s = crypto.randomUUID();
      await fxSave.addExposure(s, t);
      if (i < 2) {
        await fxSave.addSave(s, t, 'dish_saved', 'direct');
        await fxSave.addSave(s, '2035-03-13T12:01:00.000Z', 'dish_unsaved', null);
      } else if (i === 2) {
        await fxSave.addSave(s, t, 'dish_saved', 'undo');
      }
    }
    const rSave = OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, fxSave.ownerId, fxSave.venueId, now, 'synthetic'),
    );
    expect(rSave.dishes[0]!.metrics.save_rate).toEqual({ value: 0.2, status: 'NORMAL' });
  });
});

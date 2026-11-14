import { OwnerDishReportSchema } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readOwnerReport } from './owner-report';

describe.skipIf(!process.env.PEEKAPLATE_DB_ADMIN_URL || !process.env.PEEKAPLATE_DB_TEST_URL)(
  'Owner report half-open window through restricted runtime SQL',
  () => {
    const admin = new Client({ connectionString: process.env.PEEKAPLATE_DB_ADMIN_URL });
    const runtime = new Client({ connectionString: process.env.PEEKAPLATE_DB_TEST_URL });
    const venueId = crypto.randomUUID();
    const dishId = crypto.randomUUID();
    const dishRevisionId = crypto.randomUUID();
    const publicationId = crypto.randomUUID();
    const producers = new Map<string, { id: string; sequence: number }>();
    beforeAll(async () => {
      await admin.connect();
      await runtime.connect();
      await admin.query('INSERT INTO app_private.venues (id,name) VALUES ($1,$2)', [
        venueId,
        'Synthetic owner window fixture',
      ]);
      await admin.query(
        `INSERT INTO app_private.dish_current (tenant_id,dish_id,version,revision_id,name,description) VALUES ($1,$2,1,$3,'Synthetic window dish','')`,
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
      }
    }

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
        await insertFact('dish_viewed', sessionId, openingTime, {
          exposureId: crypto.randomUUID(),
        });
        await insertFact('dish_detail_opened', sessionId, openingTime, {
          openingId,
          source: 'direct',
        });
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
  },
);

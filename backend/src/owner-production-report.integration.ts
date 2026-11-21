import { ObservationQueueMessageSchema, OwnerDishReportSchema } from '@peekaplate/contracts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresObservationRepository } from './consumer/database';
import { QueueConsumer } from './consumer/queue-consumer';
import { FakeR2ArchiveStorage } from './consumer/r2-storage';
import { createDishRevision } from './dish-command';
import { createApp } from './index';
import type { LivePostHogOwnerEvent } from './owner-report-posthog';

const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;

describe.skipIf(!adminUrl || !runtimeUrl)(
  'production owner report with canonical PostgreSQL facts',
  () => {
    const admin = new Client({ connectionString: adminUrl });
    const runtime = new Client({ connectionString: runtimeUrl });
    const consumer = new QueueConsumer({
      r2Storage: new FakeR2ArchiveStorage(),
      repository: new PostgresObservationRepository(runtime),
    });
    const now = new Date('2035-02-03T12:00:00.000Z');
    const oldest = '2035-02-01T12:00:00.000Z';
    const reportStart = '2035-02-02T12:00:00.000Z';
    const today = '2035-02-03T00:00:00.000Z';
    const env = {
      APP_ENV: 'production',
      OWNER_WORKFLOW_ENABLED: 'true',
      OWNER_PRODUCTION_REPORTS_ENABLED: 'true',
      AUTH_ISSUER: 'https://owner-report-fixture.invalid/auth/v1',
      HYPERDRIVE: { connectionString: runtimeUrl! },
      POSTHOG_PROJECT_ID: '12',
      POSTHOG_OWNER_REPORT_READ_KEY: 'phx_local_fixture',
    };
    const app = createApp();

    beforeAll(async () => {
      await admin.connect();
      await runtime.connect();
    });
    afterAll(async () => {
      await runtime.end();
      await admin.end();
    });

    async function createVenue(name: string) {
      const venueId = crypto.randomUUID();
      const actorId = crypto.randomUUID();
      const dishId = crypto.randomUUID();
      const publicationId = crypto.randomUUID();
      await admin.query('INSERT INTO app_private.venues(id,name) VALUES($1,$2)', [venueId, name]);
      await admin.query(
        "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner')",
        [venueId, actorId],
      );
      const revision = await createDishRevision(runtime, actorId, venueId, {
        dishId,
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        name,
        description: 'Synthetic database fixture.',
      });
      return { venueId, actorId, dishId, dishRevisionId: revision.revisionId, publicationId };
    }

    async function visit(venue: Awaited<ReturnType<typeof createVenue>>, occurredAt: string) {
      const sessionId = crypto.randomUUID();
      const producerId = crypto.randomUUID();
      const exposureId = crypto.randomUUID();
      const dish = { dish_id: venue.dishId, dish_revision_id: venue.dishRevisionId };
      const events = [
        { type: 'menu_viewed', payload: { entry_source: 'direct_link' } },
        {
          type: 'dish_viewed',
          payload: {
            ...dish,
            exposure_id: exposureId,
            surface: 'menu_list',
            position: 1,
            exposure_basis: 'viewport_50pct_1s',
          },
        },
        {
          type: 'dish_detail_opened',
          payload: {
            ...dish,
            opening_id: crypto.randomUUID(),
            source: 'menu_card',
            from_exposure_id: exposureId,
            save_available: true,
          },
        },
      ] as const;
      const evidence: LivePostHogOwnerEvent[] = [];
      for (const [localSequence, event] of events.entries()) {
        const eventId = crypto.randomUUID();
        const envelope = ObservationQueueMessageSchema.parse({
          kind: 'observation.v2',
          tenantId: venue.venueId,
          eventId,
          sessionId,
          producerId,
          localSequence: localSequence + 1,
          schemaVersion: 'observation.v2',
          authorizedPublicationId: venue.publicationId,
          occurredAt,
          firstReceivedAt: occurredAt,
          ...event,
          traffic_class: 'live',
        });
        expect(await consumer.processMessage(envelope)).toEqual({
          status: 'acknowledged',
          reason: 'persisted',
        });
        evidence.push({
          eventId,
          publicationId: venue.publicationId,
          eventType: event.type,
        });
      }
      return evidence;
    }

    it('keeps canonical history, counts only matching current UTC events, and denies cross-tenant access', async () => {
      const venue = await createVenue('Production report fixture');
      const otherVenue = await createVenue('Other production report fixture');
      const postHogEvents: LivePostHogOwnerEvent[] = [];
      const otherEvents: LivePostHogOwnerEvent[] = [];
      for (let index = 0; index < 10; index++) {
        await visit(venue, oldest);
        await visit(venue, reportStart);
        postHogEvents.push(...(await visit(venue, today)));
        otherEvents.push(...(await visit(otherVenue, today)));
      }
      await visit(venue, today); // No PostHog evidence at the UTC midnight boundary.
      for (const event of await visit(venue, today)) {
        postHogEvents.push({ ...event, publicationId: otherVenue.publicationId });
      }
      for (const event of await visit(venue, today)) {
        postHogEvents.push({
          ...event,
          eventType: event.eventType === 'menu_viewed' ? 'dish_viewed' : 'menu_viewed',
        });
      }
      postHogEvents.push(...(await visit(venue, now.toISOString())));
      postHogEvents.push(otherEvents[0]!, {
        eventId: crypto.randomUUID(),
        publicationId: venue.publicationId,
        eventType: 'dish_detail_opened',
      });

      vi.setSystemTime(now);
      try {
        const keys = await generateKeyPair('ES256');
        const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'ES256' };
        const issueToken = (actorId: string) =>
          new SignJWT({ role: 'authenticated', is_anonymous: false })
            .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
            .setIssuer(env.AUTH_ISSUER)
            .setAudience('authenticated')
            .setSubject(actorId)
            .setExpirationTime('5m')
            .sign(keys.privateKey);
        const token = await issueToken(venue.actorId);
        const otherToken = await issueToken(otherVenue.actorId);
        const postHog = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
          const target = JSON.parse(String(init?.body)).query.values.venue_id;
          const events = target === otherVenue.venueId ? otherEvents : postHogEvents;
          return Response.json({
            columns: ['event_id', 'publication_id', 'event_type'],
            results: events.map(({ eventId, publicationId, eventType }) => [
              eventId,
              publicationId,
              eventType,
            ]),
          });
        });
        vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input) === `${env.AUTH_ISSUER}/.well-known/jwks.json`)
            return Response.json({ keys: [jwk] });
          if (String(input) === 'https://us.posthog.com/api/projects/12/query/')
            return postHog(input, init);
          throw new Error('Unexpected network request in production report fixture');
        });

        const request = (suffix: string, bearer: string, id = venue.venueId) =>
          app.request(
            `/api/v1/venues/${id}/analytics/dishes${suffix}?source=production`,
            {
              headers: { Authorization: `Bearer ${bearer}`, Origin: 'https://peekaplate.app' },
            },
            env,
          );

        for (const suffix of ['', '/export']) {
          const forbidden = await request(suffix, otherToken);
          expect(forbidden.status).toBe(403);
          expect(await forbidden.json()).toEqual({ error: 'forbidden' });
          expect((await request(suffix, token, otherVenue.venueId)).status).toBe(403);
        }
        expect(postHog).not.toHaveBeenCalled();

        const response = await request('', token);
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://peekaplate.app');
        const report = OwnerDishReportSchema.parse(await response.json());
        expect(report.venue_id).toBe(venue.venueId);
        expect(report.source).toBe('production');
        expect(report.report_metadata.freshness).toEqual({
          last_event_ingested_at: null,
          is_stale: null,
        });
        expect(
          report.dishes.map(({ dish_id, metrics }) => [dish_id, metrics.active_sessions]),
        ).toEqual([[venue.dishId, { value: 20, status: 'NORMAL' }]]);
        expect(report.summary?.current).toMatchObject({
          menu_sessions: { value: 20, status: 'NORMAL' },
          dish_opens: { value: 20, status: 'NORMAL' },
        });
        expect(report.summary?.baseline).toMatchObject({
          menu_sessions: { value: 10, status: 'NORMAL' },
          dish_opens: { value: 10, status: 'NORMAL' },
        });
        expect(report.summary?.daily_opens?.current).toEqual([
          { start_time: reportStart, end_time: today, opens: { value: 10, status: 'NORMAL' } },
          {
            start_time: today,
            end_time: now.toISOString(),
            opens: { value: 10, status: 'NORMAL' },
          },
        ]);

        const csv = await request('/export', token);
        expect(csv.status).toBe(200);
        expect(csv.headers.get('Cache-Control')).toBe('no-store');
        expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
        const [csvHeader, csvDish, ...csvRows] = (await csv.text()).trim().split('\n');
        expect(csvRows).toEqual([]);
        const cells = Object.fromEntries(
          csvHeader!.split(',').map((column, index) => [column, csvDish!.split(',')[index]]),
        );
        expect(cells).toMatchObject({
          venue_id: venue.venueId,
          source: 'production',
          dish_id: venue.dishId,
          active_sessions: '20',
          active_sessions_status: 'NORMAL',
        });
        expect(postHog).toHaveBeenCalledTimes(2);
        for (const [, init] of postHog.mock.calls) {
          expect(JSON.parse(String(init?.body)).query.values).toEqual({
            venue_id: venue.venueId,
            window_start: '2035-02-03 00:00:00.000',
            window_end: '2035-02-03 12:00:00.000',
          });
        }
        const otherResponse = await request('', otherToken, otherVenue.venueId);
        expect(otherResponse.status).toBe(200);
        const otherReport = OwnerDishReportSchema.parse(await otherResponse.json());
        expect(otherReport.venue_id).toBe(otherVenue.venueId);
        expect(
          otherReport.dishes.map(({ dish_id, metrics }) => [dish_id, metrics.active_sessions]),
        ).toEqual([[otherVenue.dishId, { value: 10, status: 'NORMAL' }]]);
        expect(postHog).toHaveBeenCalledTimes(3);
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });
  },
);

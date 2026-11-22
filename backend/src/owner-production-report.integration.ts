import {
  canonicalJson,
  ObservationQueueMessageSchema,
  OwnerDishReportSchema,
  sha256,
} from '@peekaplate/contracts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresObservationRepository } from './consumer/database';
import { QueueConsumer } from './consumer/queue-consumer';
import { FakeR2ArchiveStorage } from './consumer/r2-storage';
import { createDishRevision } from './dish-command';
import { createApp } from './index';
import { bundleKey, PREPARED_BUNDLE_PATH } from './owner-prepare';
import type { LivePostHogOwnerEvent } from './owner-report-posthog';
import { approveMenuRevision, publishMenu } from './publication-command';

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
    const now = new Date('2035-02-03T00:06:00.000Z');
    const latestEnd = '2035-02-03T00:05:00.000Z';
    const oldest = '2035-02-02T23:50:00.000Z';
    const reportStart = '2035-02-02T23:55:00.000Z';
    const today = '2035-02-03T00:00:00.000Z';
    const bundles = new Map<string, ArrayBuffer>();
    const env = {
      APP_ENV: 'production',
      OWNER_WORKFLOW_ENABLED: 'true',
      OWNER_PRODUCTION_REPORTS_ENABLED: 'true',
      AUTH_ISSUER: 'https://owner-report-fixture.invalid/auth/v1',
      HYPERDRIVE: { connectionString: runtimeUrl! },
      POSTHOG_PROJECT_ID: '12',
      POSTHOG_OWNER_REPORT_READ_KEY: 'phx_local_fixture',
      INGESTION_REPORTS_BUCKET: {
        get: async (key: string) => {
          const bytes = bundles.get(key);
          return bytes ? { arrayBuffer: async () => bytes } : null;
        },
        put: async (key: string, bytes: ArrayBuffer) => {
          if (bundles.has(key)) return null;
          bundles.set(key, bytes);
          return {};
        },
      },
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
      const menuId = crypto.randomUUID();
      const menuRevisionId = crypto.randomUUID();
      const contentApprovalId = crypto.randomUUID();
      const assetApprovalId = crypto.randomUUID();
      const bytes = new TextEncoder().encode(
        canonicalJson({
          schema_version: 1,
          venue_id: venueId,
          menu_id: menuId,
          menu_revision_id: menuRevisionId,
          restaurant: { name, logo: null },
          categories: [
            {
              category_id: crypto.randomUUID(),
              name: 'Mains',
              dishes: [
                {
                  dish_id: dishId,
                  dish_revision_id: revision.revisionId,
                  complete: true,
                  name,
                  description: 'Synthetic fixture dish.',
                  ingredients: [
                    { ingredient_id: crypto.randomUUID(), name: 'Rice', description: null },
                  ],
                  price: { amount: '5', currency: 'USD' },
                  allergens: [],
                  dietary: [],
                  images: null,
                },
              ],
            },
          ],
        }),
      );
      await admin.query(
        `INSERT INTO app_private.menu_review_subject
          (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          venueId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          await sha256(bytes),
          assetApprovalId,
          'a'.repeat(64),
        ],
      );
      await admin.query(
        `INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
         VALUES ($1,$2,$3,$4)`,
        [
          venueId,
          menuId,
          menuRevisionId,
          `https://api.peekaplate.app${PREPARED_BUNDLE_PATH}/${venueId}/${menuId}/${menuRevisionId}.json`,
        ],
      );
      const storageKey = bundleKey(venueId, menuId, menuRevisionId);
      bundles.set(storageKey, Uint8Array.from(bytes).buffer);
      const approval = await approveMenuRevision(runtime, actorId, venueId, {
        menuId,
        menuRevisionId,
        contentApprovalId,
        assetApprovalId,
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
      });
      const { publicationId } = await publishMenu(runtime, actorId, venueId, {
        menuId,
        approvalId: approval.approvalId,
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
      });
      return {
        venueId,
        actorId,
        dishId,
        dishRevisionId: revision.revisionId,
        publicationId,
        storageKey,
      };
    }

    async function visit(
      venue: Awaited<ReturnType<typeof createVenue>>,
      occurredAt: string,
      production = true,
      save = false,
    ) {
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
        ...(save
          ? [
              {
                type: 'dish_saved' as const,
                payload: {
                  ...dish,
                  save_origin: 'direct',
                  save_surface: 'menu_list',
                  shortlist_size: 1,
                },
              },
            ]
          : []),
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
          ...(production ? { sourceEnvironment: 'production' } : {}),
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

    it('seals matching production batches, uses canonical previous UTC data, and isolates two restaurants', async () => {
      const venue = await createVenue('Production report fixture');
      const otherVenue = await createVenue('Other production report fixture');
      const postHogEvents: LivePostHogOwnerEvent[] = [];
      const otherEvents: LivePostHogOwnerEvent[] = [];
      for (let index = 0; index < 10; index++) {
        await visit(venue, oldest);
        await visit(venue, reportStart);
        postHogEvents.push(...(await visit(venue, today, true, index === 0)));
        otherEvents.push(...(await visit(otherVenue, today)));
      }
      await visit(venue, today); // No PostHog evidence at the UTC midnight boundary.
      await visit(venue, reportStart, false); // Legacy history has no production provenance.
      postHogEvents.push(...(await visit(venue, today, false)));
      const mismatchedDish = await visit({ ...venue, dishRevisionId: crypto.randomUUID() }, today);
      postHogEvents.push(...mismatchedDish.filter((event) => event.eventType !== 'menu_viewed'));
      for (const event of await visit(venue, today)) {
        postHogEvents.push({ ...event, publicationId: otherVenue.publicationId });
      }
      for (const event of await visit(venue, today)) {
        postHogEvents.push({
          ...event,
          eventType: event.eventType === 'menu_viewed' ? 'dish_viewed' : 'menu_viewed',
        });
      }
      postHogEvents.push(...(await visit(venue, latestEnd)));
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
            .setExpirationTime('15m')
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
        expect(report.report_metadata.calculation_version).toBe('production.batch.v1');
        expect(report.report_metadata.freshness).toEqual({
          last_event_ingested_at: null,
          is_stale: null,
        });
        expect(
          report.dishes.map(({ dish_id, metrics }) => [dish_id, metrics.active_sessions]),
        ).toEqual([[venue.dishId, { value: 10, status: 'NORMAL' }]]);
        expect(report.dishes[0]?.metrics.save_rate).toEqual({ value: null, status: 'SUPPRESSED' });
        expect(report.summary?.current).toMatchObject({
          menu_sessions: { value: 10, status: 'NORMAL' },
          dish_opens: { value: 10, status: 'NORMAL' },
        });
        expect(report.summary?.baseline).toMatchObject({
          menu_sessions: { value: 10, status: 'NORMAL' },
          dish_opens: { value: 10, status: 'NORMAL' },
        });
        expect(report.summary?.daily_opens?.current).toEqual([
          {
            start_time: today,
            end_time: latestEnd,
            opens: { value: 10, status: 'NORMAL' },
          },
        ]);
        expect(report.summary?.daily_opens?.baseline).toEqual([
          { start_time: reportStart, end_time: today, opens: { value: 10, status: 'NORMAL' } },
        ]);
        postHogEvents.push(...(await visit(venue, today)));
        expect(await (await request('', token)).json()).toEqual(report);

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
          active_sessions: '10',
          active_sessions_status: 'NORMAL',
        });
        expect(postHog).toHaveBeenCalledTimes(1);
        for (const [, init] of postHog.mock.calls) {
          expect(JSON.parse(String(init?.body)).query.values).toEqual({
            venue_id: venue.venueId,
            window_start: '2035-02-03 00:00:00.000',
            window_end: '2035-02-03 00:05:00.000',
          });
        }
        const otherResponse = await request('', otherToken, otherVenue.venueId);
        expect(otherResponse.status).toBe(200);
        const otherReport = OwnerDishReportSchema.parse(await otherResponse.json());
        expect(otherReport.venue_id).toBe(otherVenue.venueId);
        expect(
          otherReport.dishes.map(({ dish_id, metrics }) => [dish_id, metrics.active_sessions]),
        ).toEqual([[otherVenue.dishId, { value: 10, status: 'NORMAL' }]]);
        expect(postHog).toHaveBeenCalledTimes(2);

        for (let index = 0; index < 10; index++) {
          postHogEvents.push(...(await visit(venue, latestEnd)));
          if (index === 0) otherEvents.push(...(await visit(otherVenue, latestEnd)));
        }
        vi.setSystemTime(new Date('2035-02-03T00:11:00.000Z'));
        const nextResponse = await request('', token);
        expect(nextResponse.status).toBe(200);
        const refreshed = OwnerDishReportSchema.parse(await nextResponse.json());
        expect(refreshed.summary?.current.dish_opens).toEqual({ value: 11, status: 'NORMAL' });
        expect(refreshed.summary?.baseline.dish_opens).toEqual({ value: 10, status: 'NORMAL' });
        const otherNextResponse = await request('', otherToken, otherVenue.venueId);
        expect(otherNextResponse.status).toBe(200);
        const otherRefreshed = OwnerDishReportSchema.parse(await otherNextResponse.json());
        expect(otherRefreshed.summary?.current.dish_opens).toEqual({
          value: 1,
          status: 'NORMAL',
        });
        expect(otherRefreshed.summary?.current.menu_sessions).toEqual({
          value: 1,
          status: 'NORMAL',
        });
        expect(otherRefreshed.summary?.daily_opens?.current[0]?.opens).toEqual({
          value: 1,
          status: 'NORMAL',
        });
        expect(otherRefreshed.dishes).toEqual([]);
        expect(otherRefreshed.summary?.baseline.dish_opens).toEqual({
          value: 10,
          status: 'NORMAL',
        });
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });
  },
);

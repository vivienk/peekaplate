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
import { readOwnerReportDisplayActions } from './owner-report-display-actions';
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
      OWNER_REPORT_DISPLAY_ACTIONS_ENABLED: 'true',
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

    async function createVenue(name: string, hasPortion = false) {
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
                  ...(hasPortion
                    ? {
                        portion: {
                          schema_version: 1,
                          dish_id: dishId,
                          dish_revision_id: revision.revisionId,
                          width: 480,
                          height: 480,
                          layers: [
                            {
                              url: 'https://assets.invalid/background.webp',
                              sha256: 'a'.repeat(64),
                              size_bytes: 90,
                              depth: 0,
                            },
                            {
                              url: 'https://assets.invalid/foreground.webp',
                              sha256: 'b'.repeat(64),
                              size_bytes: 90,
                              depth: 1,
                            },
                          ],
                        },
                      }
                    : {}),
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
      preview = false,
      activeMs?: number,
    ) {
      const sessionId = crypto.randomUUID();
      const producerId = crypto.randomUUID();
      const exposureId = crypto.randomUUID();
      const openingId = crypto.randomUUID();
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
            opening_id: openingId,
            source: 'menu_card',
            from_exposure_id: exposureId,
            save_available: true,
          },
        },
        ...(activeMs === undefined
          ? []
          : [
              {
                type: 'dish_activity_checkpoint' as const,
                payload: { ...dish, opening_id: openingId, active_ms: activeMs, final: true },
              },
            ]),
        ...(preview ? [{ type: 'dish_portion_opened' as const, payload: dish }] : []),
        ...(save
          ? [
              {
                type: 'dish_saved' as const,
                payload: {
                  ...dish,
                  save_origin: 'direct',
                  save_surface: 'menu_card',
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

    it('counts only approved 2.5D renders and deduplicates comparison pairs within a start', async () => {
      const venue = await createVenue('Display action fixture');
      const anchor = { id: venue.dishId, revision: venue.dishRevisionId, has_portion: true };
      const sideA = { id: crypto.randomUUID(), revision: crypto.randomUUID(), has_portion: false };
      const sideB = { id: crypto.randomUUID(), revision: crypto.randomUUID(), has_portion: false };
      const published = { publicationId: venue.publicationId, dishes: [anchor, sideA, sideB] };
      const events: LivePostHogOwnerEvent[] = [];
      const add = async (
        eventType: 'dish_portion_opened' | 'dish_compared',
        payload: Record<string, unknown>,
        sessionId: string,
        corroborated = true,
      ) => {
        const eventId = crypto.randomUUID();
        const result = await consumer.processMessage(
          ObservationQueueMessageSchema.parse({
            kind: 'observation.v2',
            tenantId: venue.venueId,
            eventId,
            sessionId,
            producerId: crypto.randomUUID(),
            localSequence: 1,
            schemaVersion: 'observation.v2',
            authorizedPublicationId: venue.publicationId,
            occurredAt: today,
            firstReceivedAt: today,
            type: eventType,
            payload,
            traffic_class: 'live',
            sourceEnvironment: 'production',
          }),
        );
        expect(result).toEqual({ status: 'acknowledged', reason: 'persisted' });
        if (corroborated) events.push({ eventId, publicationId: venue.publicationId, eventType });
      };
      const portion = { dish_id: anchor.id, dish_revision_id: anchor.revision };
      for (let index = 0; index < 10; index++) {
        const sessionId = crypto.randomUUID();
        const comparison_id = crypto.randomUUID();
        await add('dish_portion_opened', portion, sessionId);
        for (const entry of [sideA, sideB]) {
          await add(
            'dish_compared',
            {
              ...portion,
              other_dish_id: entry.id,
              other_dish_revision_id: entry.revision,
              comparison_id,
              compare_action: 'start',
              save_available: true,
            },
            sessionId,
          );
        }
        await add(
          'dish_compared',
          {
            ...portion,
            other_dish_id: sideA.id,
            other_dish_revision_id: sideA.revision,
            comparison_id,
            compare_action: 'replace',
            save_available: true,
          },
          sessionId,
        );
      }
      await add('dish_portion_opened', portion, crypto.randomUUID(), false);
      await add(
        'dish_portion_opened',
        {
          dish_id: anchor.id,
          dish_revision_id: crypto.randomUUID(),
        },
        crypto.randomUUID(),
      );
      await add(
        'dish_portion_opened',
        {
          dish_id: sideA.id,
          dish_revision_id: sideA.revision,
        },
        crypto.randomUUID(),
      );

      await runtime.query('BEGIN READ ONLY');
      try {
        await runtime.query("SELECT set_config('app.tenant_id', $1, true)", [venue.venueId]);
        const result = await readOwnerReportDisplayActions(
          runtime,
          venue.venueId,
          new Date(today),
          new Date(latestEnd),
          { start: new Date(today), events, publications: [published] },
          new Set([anchor.id, sideA.id, sideB.id]),
        );
        const observed = { value: 10, status: 'NORMAL' };
        expect(result.portionTotal).toEqual(observed);
        expect(result.byDish.get(anchor.id)).toEqual({
          comparisons_started: observed,
          portion_previews_shown: observed,
        });
        expect(result.byDish.get(sideA.id)).toEqual({ comparisons_started: observed });
        expect(result.byDish.get(sideB.id)).toEqual({ comparisons_started: observed });
        const firstVisit = await readOwnerReportDisplayActions(
          runtime,
          venue.venueId,
          new Date(today),
          new Date(latestEnd),
          { start: new Date(today), events: events.slice(0, 4), publications: [published] },
          new Set(),
          true,
        );
        const singleAction = { value: 1, status: 'NORMAL' };
        expect(firstVisit.portionTotal).toEqual(singleAction);
        expect(firstVisit.byDish.get(anchor.id)).toEqual({
          comparisons_started: singleAction,
          portion_previews_shown: singleAction,
        });
        expect(firstVisit.byDish.get(sideA.id)).toEqual({ comparisons_started: singleAction });
        expect(firstVisit.dishNames.get(anchor.id)).toBe('Display action fixture');
        const smallComplement = await readOwnerReportDisplayActions(
          runtime,
          venue.venueId,
          new Date(today),
          new Date(latestEnd),
          {
            start: new Date(today),
            events,
            publications: [
              {
                ...published,
                dishes: [anchor, { ...sideA, has_portion: true }, sideB],
              },
            ],
          },
          new Set([anchor.id, sideA.id, sideB.id]),
        );
        expect(smallComplement.portionTotal).toEqual({ value: null, status: 'SUPPRESSED' });
        expect(smallComplement.byDish.get(anchor.id)?.portion_previews_shown).toEqual(observed);
        const omittedDish = await readOwnerReportDisplayActions(
          runtime,
          venue.venueId,
          new Date(today),
          new Date(latestEnd),
          { start: new Date(today), events, publications: [published] },
          new Set(),
        );
        expect(omittedDish.portionTotal).toEqual({ value: null, status: 'SUPPRESSED' });
      } finally {
        await runtime.query('ROLLBACK');
      }
    });

    it('seals matching production batches, uses canonical previous UTC data, and isolates two restaurants', async () => {
      const venue = await createVenue('Production report fixture', true);
      const otherVenue = await createVenue('Other production report fixture');
      const postHogEvents: LivePostHogOwnerEvent[] = [];
      const otherEvents: LivePostHogOwnerEvent[] = [];
      for (let index = 0; index < 10; index++) {
        await visit(venue, oldest);
        await visit(venue, reportStart);
        postHogEvents.push(...(await visit(venue, today, true, index === 0, true)));
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

        const request = (
          suffix: string,
          bearer: string,
          id = venue.venueId,
          extended = true,
          enabled = 'true',
          window?: 'sf-day' | 'sf-today',
          cutover: string | null = '2035-02-03T08:00:00.000Z',
          liveStart?: string,
        ) =>
          app.request(
            `/api/v1/venues/${id}/analytics/dishes${suffix}?source=production${extended ? '&displayActions=true' : ''}`,
            {
              headers: { Authorization: `Bearer ${bearer}`, Origin: 'https://peekaplate.app' },
            },
            {
              ...env,
              OWNER_REPORT_DISPLAY_ACTIONS_ENABLED: enabled,
              ...(cutover ? { OWNER_PRODUCTION_REPORT_DISH_DAY_START: cutover } : {}),
              ...(window ? { OWNER_PRODUCTION_REPORT_WINDOW: window } : {}),
              ...(liveStart ? { OWNER_PRODUCTION_REPORT_DISH_LIVE_START: liveStart } : {}),
            },
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
        expect(report.dishes[0]?.display_actions?.portion_previews_shown).toEqual({
          value: 10,
          status: 'NORMAL',
        });
        expect(report.summary?.current).toMatchObject({
          menu_sessions: { value: 10, status: 'NORMAL' },
          dish_opens: { value: 10, status: 'NORMAL' },
          portion_previews_shown: { value: 10, status: 'NORMAL' },
        });
        const withoutCutover = await request(
          '',
          token,
          venue.venueId,
          true,
          'true',
          undefined,
          null,
        );
        expect(withoutCutover.status).toBe(200);
        const countsOnly = OwnerDishReportSchema.parse(await withoutCutover.json());
        expect(countsOnly.dishes).toEqual([]);
        expect(countsOnly.summary?.current).toMatchObject({
          dish_opens: { value: 10, status: 'NORMAL' },
          portion_previews_shown: { value: null, status: 'MISSING' },
        });
        const legacy = OwnerDishReportSchema.parse(
          await (await request('', token, venue.venueId, false)).json(),
        );
        expect(legacy.dishes[0]?.display_actions).toBeUndefined();
        expect(legacy.summary?.current.portion_previews_shown).toEqual({
          value: null,
          status: 'MISSING',
        });
        const rolledBack = OwnerDishReportSchema.parse(
          await (await request('', token, venue.venueId, true, 'false')).json(),
        );
        expect(rolledBack).toEqual(legacy);
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

        const daily = () => request('', token, venue.venueId, true, 'true', 'sf-day');
        const beforeDaily = await daily();
        expect(beforeDaily.status).toBe(200);
        const day = OwnerDishReportSchema.parse(await beforeDaily.json());
        expect(day.report_metadata.calculation_version).toBe('production.sf-day.v1');
        expect(day.summary?.periods).toEqual({
          current: { start_time: '2035-02-02T08:00:00.000Z', end_time: '2035-02-03T00:10:00.000Z' },
          baseline: {
            start_time: '2035-02-01T08:00:00.000Z',
            end_time: '2035-02-02T08:00:00.000Z',
          },
        });
        expect(day.summary?.current.dish_opens).toEqual({ value: 42, status: 'NORMAL' });
        expect(day.summary?.current.portion_previews_shown).toEqual({
          value: null,
          status: 'MISSING',
        });
        expect(day.dishes).toEqual([]);
        expect(await (await daily()).json()).toEqual(day);
        const callsBeforeDenial = postHog.mock.calls.length;
        expect((await request('', otherToken, venue.venueId, true, 'true', 'sf-day')).status).toBe(
          403,
        );
        expect(postHog).toHaveBeenCalledTimes(callsBeforeDenial);

        // No new diner events in the next five minutes. Earlier activity stays in today's report.
        vi.setSystemTime(new Date('2035-02-03T00:16:00.000Z'));
        const quiet = await daily();
        expect(quiet.status).toBe(200);
        const quietDay = OwnerDishReportSchema.parse(await quiet.json());
        expect(quietDay.summary?.current).toEqual(day.summary?.current);
        expect(quietDay.dishes).toEqual(day.dishes);
        expect(quietDay.summary?.periods.current.end_time).toBe('2035-02-03T00:15:00.000Z');

        vi.setSystemTime(new Date('2035-02-03T08:00:30.000Z'));
        const pendingMidnight = await request(
          '',
          await issueToken(venue.actorId),
          venue.venueId,
          true,
          'true',
          'sf-day',
        );
        expect(pendingMidnight.status).toBe(200);
        expect(
          OwnerDishReportSchema.parse(await pendingMidnight.json()).summary?.periods.current,
        ).toEqual({
          start_time: '2035-02-02T08:00:00.000Z',
          end_time: '2035-02-03T07:55:00.000Z',
        });
        postHogEvents.push(...(await visit(venue, '2035-02-03T07:59:00.000Z', true, false, true)));

        // At Pacific midnight, yesterday's evening still requires matching events after UTC midnight.
        vi.setSystemTime(new Date('2035-02-03T08:01:00.000Z'));
        const midnight = await request(
          '',
          await issueToken(venue.actorId),
          venue.venueId,
          true,
          'true',
          'sf-day',
        );
        expect(midnight.status).toBe(200);
        const newDay = OwnerDishReportSchema.parse(await midnight.json());
        expect(newDay.summary?.periods.current).toEqual({
          start_time: '2035-02-03T08:00:00.000Z',
          end_time: '2035-02-03T08:00:00.000Z',
        });
        expect(newDay.summary?.current.dish_opens.value).toBeNull();
        expect(newDay.summary?.baseline.dish_opens).toEqual({ value: 43, status: 'NORMAL' });
        // This day's legacy snapshot disclosed exactly ten previews. Publishing eleven from
        // the same day would reveal the previously suppressed last preview by subtraction.
        expect(newDay.summary?.baseline.portion_previews_shown).toEqual({
          value: null,
          status: 'MISSING',
        });
        expect(newDay.dishes).toEqual([]);
        expect(newDay.report_metadata.date_window).toMatchObject(
          newDay.summary?.periods.baseline ?? {},
        );
        expect(JSON.parse(String(postHog.mock.lastCall?.[1]?.body)).query.values).toMatchObject({
          window_start: '2035-02-03 00:00:00.000',
          window_end: '2035-02-03 08:00:00.000',
        });
        const cutover = '2035-02-03T08:00:00.000Z';
        for (let index = 0; index < 9; index++) {
          postHogEvents.push(
            ...(await visit(venue, '2035-02-03T07:59:00.000Z', true, false, true)),
          );
          postHogEvents.push(
            ...(await visit(venue, '2035-02-03T08:02:00.000Z', true, false, true, 10_000)),
          );
        }
        const boundary = await request('', await issueToken(venue.actorId));
        expect(boundary.status).toBe(200);
        const boundaryReport = OwnerDishReportSchema.parse(await boundary.json());
        expect(boundaryReport.summary?.periods.current.end_time).toBe(cutover);
        expect(boundaryReport.summary?.current.portion_previews_shown).toEqual({
          value: 10,
          status: 'NORMAL',
        });
        const boundaryKey = `owner-report-batches/v1/${venue.venueId}/${cutover}.json`;
        const sealedBoundary = bundles.get(boundaryKey)?.slice(0);
        expect(sealedBoundary).toBeDefined();

        // The rollback route can return venue counts but must never expose protected
        // five-minute metrics for the same day as a future completed-day report.
        vi.setSystemTime(new Date('2035-02-03T08:06:00.000Z'));
        const rollback = await request('', await issueToken(venue.actorId));
        expect(rollback.status).toBe(200);
        const rollbackReport = OwnerDishReportSchema.parse(await rollback.json());
        expect(rollbackReport.dishes).toEqual([]);
        expect(rollbackReport.summary?.current).toMatchObject({
          menu_sessions: { value: 9, status: 'NORMAL' },
          dish_opens: { value: 9, status: 'NORMAL' },
          portion_previews_shown: { value: null, status: 'MISSING' },
        });
        expect(rollbackReport.summary?.baseline).toMatchObject({
          menu_sessions: { value: 10, status: 'NORMAL' },
          dish_opens: { value: 10, status: 'NORMAL' },
          portion_previews_shown: { value: null, status: 'MISSING' },
          avg_interaction_time_seconds: { value: null, status: 'MISSING' },
          verified_orders: { value: null, status: 'MISSING' },
        });
        expect(bundles.get(boundaryKey)).toEqual(sealedBoundary);
        vi.setSystemTime(new Date('2035-02-03T08:11:00.000Z'));
        const adjacent = await request('', await issueToken(venue.actorId));
        expect(OwnerDishReportSchema.parse(await adjacent.json()).summary?.baseline).toMatchObject({
          dish_opens: { value: 9, status: 'NORMAL' },
          portion_previews_shown: { value: null, status: 'MISSING' },
        });

        // Ten finalized sessions from one Pacific day straddle UTC midnight 9 + 1.
        postHogEvents.push(
          ...(await visit(venue, '2035-02-04T00:00:00.000Z', true, false, true, 20_000)),
        );
        const dailyWithFreshToken = async (suffix = '') =>
          request(suffix, await issueToken(venue.actorId), venue.venueId, true, 'true', 'sf-day');
        vi.setSystemTime(new Date('2035-02-04T08:01:00.000Z'));
        const closedDayResponse = await dailyWithFreshToken();
        expect(closedDayResponse.status).toBe(200);
        const closedDay = OwnerDishReportSchema.parse(await closedDayResponse.json());
        expect(closedDay.summary?.daily_opens).toBeUndefined();
        expect(closedDay.summary?.baseline.avg_interaction_time_seconds).toEqual({
          value: 11,
          status: 'NORMAL',
        });
        expect(closedDay.summary?.current.avg_interaction_time_seconds).toEqual({
          value: null,
          status: 'MISSING',
        });
        expect(closedDay.dishes[0]?.display_actions?.portion_previews_shown).toEqual({
          value: 10,
          status: 'NORMAL',
        });
        expect(closedDay.summary?.baseline.portion_previews_shown).toEqual({
          value: 10,
          status: 'NORMAL',
        });

        // A lone preview today and a late arrival yesterday must not change sealed dish data.
        postHogEvents.push(
          ...(await visit(venue, '2035-02-04T07:59:10.000Z', true, false, true)),
          ...(await visit(venue, '2035-02-04T08:02:00.000Z', true, true, true, 12_000)),
        );
        vi.setSystemTime(new Date('2035-02-04T08:06:00.000Z'));
        const nextDayResponse = await dailyWithFreshToken();
        expect(nextDayResponse.status).toBe(200);
        const nextDay = OwnerDishReportSchema.parse(await nextDayResponse.json());
        expect(nextDay.summary?.current.dish_opens).toEqual({ value: 1, status: 'NORMAL' });
        expect(nextDay.summary?.current.portion_previews_shown.value).toBeNull();
        expect(nextDay.summary?.baseline).toEqual(closedDay.summary?.baseline);
        expect(nextDay.dishes).toEqual(closedDay.dishes);
        const csvDay = await dailyWithFreshToken('/export');
        expect(csvDay.status).toBe(200);
        const [header, firstDish] = (await csvDay.text()).trim().split('\n');
        const dayCells = Object.fromEntries(
          header!.split(',').map((column, index) => [column, firstDish!.split(',')[index]]),
        );
        expect(dayCells).toMatchObject({
          window_start: '2035-02-03T08:00:00.000Z',
          window_end: '2035-02-04T08:00:00.000Z',
        });
        vi.setSystemTime(new Date('2035-02-05T08:01:00.000Z'));
        const smallDayResponse = await dailyWithFreshToken();
        expect(smallDayResponse.status).toBe(200);
        const smallDay = OwnerDishReportSchema.parse(await smallDayResponse.json());
        expect(smallDay.summary?.baseline).toMatchObject({
          menu_sessions: { value: 1, status: 'NORMAL' },
          dish_opens: { value: 1, status: 'NORMAL' },
          avg_interaction_time_seconds: { value: 12, status: 'NORMAL' },
          portion_previews_shown: { value: 1, status: 'NORMAL' },
          verified_orders: { value: null, status: 'MISSING' },
        });
        expect(smallDay.dishes[0]?.metrics).toEqual({
          active_sessions: { value: 1, status: 'NORMAL' },
          avg_interaction_time_seconds: { value: 12, status: 'NORMAL' },
          timing_coverage: { value: 1, status: 'NORMAL' },
          open_rate: { value: 1, status: 'NORMAL' },
          engagement_rate: { value: 1, status: 'NORMAL' },
          save_rate: { value: 1, status: 'NORMAL' },
        });
        expect(smallDay.dishes[0]?.display_actions?.portion_previews_shown).toEqual({
          value: 1,
          status: 'NORMAL',
        });
        expect(smallDay.report_metadata.freshness.is_stale).toBeNull();
        const smallDayCsv = await dailyWithFreshToken('/export');
        expect(smallDayCsv.status).toBe(200);
        const [columns, row] = (await smallDayCsv.text()).trim().split('\n');
        const metrics = Object.fromEntries(
          columns!.split(',').map((key, index) => [key, row!.split(',')[index]]),
        );
        expect(metrics).toMatchObject({
          active_sessions: '1',
          open_rate: '1',
          save_rate: '1',
          avg_interaction_time_seconds: '12',
        });
        vi.setSystemTime(new Date('2035-02-05T08:06:00.000Z'));
        const refreshedSmallDay = await dailyWithFreshToken();
        expect(refreshedSmallDay.status).toBe(200);
        const refreshedReport = OwnerDishReportSchema.parse(await refreshedSmallDay.json());
        expect(refreshedReport.summary?.baseline).toEqual(smallDay.summary?.baseline);
        expect(refreshedReport.dishes).toEqual(smallDay.dishes);
        const refreshedCsv = await dailyWithFreshToken('/export');
        expect(refreshedCsv.status).toBe(200);
        expect(await refreshedCsv.text()).toContain(',1,NORMAL,12,NORMAL,');
        expect(otherRefreshed.dishes).toEqual([]);
        expect(otherRefreshed.summary?.baseline.dish_opens).toEqual({
          value: 10,
          status: 'NORMAL',
        });

        // One visit before the partial-day cutover and one eligible matched visit after it.
        postHogEvents.push(
          ...(await visit(venue, '2035-02-05T08:02:00.000Z', true, true, true, 15_000)),
          ...(await visit(venue, '2035-02-05T08:07:00.000Z', true, true, true, 18_000)),
        );
        const todayWithFreshToken = async (
          suffix = '',
          actor = venue.actorId,
          closedDayCutover = '2035-02-04T08:00:00.000Z',
        ) =>
          request(
            suffix,
            await issueToken(actor),
            venue.venueId,
            true,
            'true',
            'sf-today',
            closedDayCutover,
            '2035-02-05T08:05:00.000Z',
          );
        const pending = await todayWithFreshToken();
        expect(OwnerDishReportSchema.parse(await pending.json()).dishes).toEqual([]);
        vi.setSystemTime(new Date('2035-02-05T08:11:00.000Z'));
        const live = await todayWithFreshToken();
        expect(live.status).toBe(200);
        const todayReport = OwnerDishReportSchema.parse(await live.json());
        expect(todayReport.report_metadata.calculation_version).toBe('production.sf-today.v1');
        expect(todayReport.report_metadata.date_window).toMatchObject({
          start_time: '2035-02-05T08:05:00.000Z',
          end_time: '2035-02-05T08:10:00.000Z',
        });
        expect(todayReport.summary?.current.dish_opens).toEqual({ value: 2, status: 'NORMAL' });
        expect(todayReport.dishes[0]?.metrics.active_sessions).toEqual({
          value: 1,
          status: 'NORMAL',
        });
        expect(todayReport.dishes[0]?.metrics.avg_interaction_time_seconds).toEqual({
          value: 18,
          status: 'NORMAL',
        });
        expect(todayReport.dishes[0]?.display_actions?.portion_previews_shown).toEqual({
          value: 1,
          status: 'NORMAL',
        });
        expect(todayReport.summary?.current.portion_previews_shown).toEqual({
          value: null,
          status: 'MISSING',
        });
        expect(todayReport.summary?.baseline.portion_previews_shown).toEqual({
          value: 1,
          status: 'NORMAL',
        });
        const stricter = await todayWithFreshToken('', venue.actorId, '2035-02-06T08:00:00.000Z');
        const gated = OwnerDishReportSchema.parse(await stricter.json());
        expect(gated.dishes).toEqual(todayReport.dishes);
        expect(gated.summary?.baseline.portion_previews_shown).toEqual({
          value: null,
          status: 'MISSING',
        });
        const todayCsv = await todayWithFreshToken('/export');
        expect(todayCsv.status).toBe(200);
        expect(await todayCsv.text()).toContain(
          '2035-02-05T08:05:00.000Z,2035-02-05T08:10:00.000Z',
        );
        expect((await todayWithFreshToken('', otherVenue.actorId)).status).toBe(403);
        expect((await todayWithFreshToken('/export', otherVenue.actorId)).status).toBe(403);
        vi.setSystemTime(new Date('2035-02-05T08:16:00.000Z'));
        const quietToday = await todayWithFreshToken();
        expect(quietToday.status).toBe(200);
        expect(OwnerDishReportSchema.parse(await quietToday.json()).dishes).toEqual(
          todayReport.dishes,
        );
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }, 30_000);
  },
);

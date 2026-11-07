import { createServer, type Server } from 'node:http';
import { OwnerDishReportV2Schema } from '@peekaplate/contracts';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffVerifier } from './auth';
import { createApp } from './index';
import { readOwnerReport } from './owner-report';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
const describeDatabase = describe.skipIf(!runtimeUrl || !adminUrl);
const startTime = '2026-11-06T00:00:00.000Z';
const endTime = '2026-11-07T00:00:00.000Z';
const venueId = crypto.randomUUID();
const actorId = crypto.randomUUID();
const dishId = crypto.randomUUID();
const firstRevisionId = crypto.randomUUID();
const suppressedRevisionId = crypto.randomUUID();
const smallNumeratorRevisionId = crypto.randomUUID();
const smallComplementRevisionId = crypto.randomUUID();
const boundaryRateRevisionId = crypto.randomUUID();
const publicationId = crypto.randomUUID();
const producerId = crypto.randomUUID();
const admin = new Client({ connectionString: adminUrl });
let server: Server;
let issuer: string;
let privateKey: CryptoKey;
let publicJwk: JWK;
let verify: ReturnType<typeof createStaffVerifier>;

describeDatabase('owner report integration', () => {
  beforeAll(async () => {
    const keys = await generateKeyPair('ES256');
    privateKey = keys.privateKey;
    publicJwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: 'owner-report-test',
      use: 'sig',
      alg: 'ES256',
    };
    server = createServer((request, response) => {
      if (request.url !== '/auth/v1/.well-known/jwks.json') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('JWKS test server failed to start.');
    issuer = `http://127.0.0.1:${address.port}/auth/v1`;
    verify = createStaffVerifier({ issuer, allowLocalIssuer: true });

    await admin.connect();
    await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
      venueId,
      'Synthetic owner report integration',
    ]);
    await admin.query(
      'INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, $3)',
      [venueId, actorId, 'viewer'],
    );
    await insertDishRevision(firstRevisionId, 1, 'Visible dish');
    await insertDishRevision(suppressedRevisionId, 2, 'Low-volume revision');
    await insertDishRevision(smallNumeratorRevisionId, 3, 'Small numerator revision');
    await insertDishRevision(smallComplementRevisionId, 4, 'Small complement revision');
    await insertDishRevision(boundaryRateRevisionId, 5, 'Boundary rate revision');

    for (let index = 0; index < 10; index++) {
      const eventId = crypto.randomUUID();
      const input = {
        eventId,
        sessionId: crypto.randomUUID(),
        exposureId: crypto.randomUUID(),
        revisionId: firstRevisionId,
        occurredAt:
          index === 0 ? startTime : `2026-11-06T${String(index).padStart(2, '0')}:00:00.000Z`,
      };
      await insertDisplayEvent(input);
      if (index === 0) await insertDisplayEvent(input);
    }
    await insertDisplayEvent({
      eventId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      exposureId: crypto.randomUUID(),
      revisionId: firstRevisionId,
      occurredAt: endTime,
    });
    for (let index = 0; index < 9; index++) {
      await insertDisplayEvent({
        eventId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        exposureId: crypto.randomUUID(),
        revisionId: suppressedRevisionId,
        occurredAt: `2026-11-06T${String(index + 1).padStart(2, '0')}:30:00.000Z`,
      });
    }
    await insertRevisionTraffic(smallNumeratorRevisionId, 9);
    await insertRevisionTraffic(smallComplementRevisionId, 11);
    await insertRevisionTraffic(boundaryRateRevisionId, 10);
  }, 45_000);

  afterAll(async () => {
    if (admin.connection) await admin.end();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('reconciles timestamp boundaries and duplicate deliveries without exposing small cohorts', async () => {
    const token = await staffToken(actorId);
    let readFailure: unknown;
    const app = createApp({
      verify,
      execute: async () => {
        throw new Error('Dish writes are not part of this test.');
      },
      readOwnerReport: async (actor, venue, query, env) => {
        const client = new Client({ connectionString: env.LOCAL_DATABASE_URL });
        await client.connect();
        try {
          return await readOwnerReport(client, actor, venue, query);
        } catch (error) {
          readFailure = error;
          throw error;
        } finally {
          await client.end();
        }
      },
    });
    const response = await app.request(
      `/venues/${venueId}/owner-report?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl },
    );

    expect(response.status, readFailure instanceof Error ? readFailure.message : undefined).toBe(
      200,
    );
    const report = OwnerDishReportV2Schema.parse(await response.json());
    expect(report.schema_version).toBe('owner_report.v2');
    expect(JSON.stringify(report)).not.toContain('eligible_sessions');
    const visible = report.dishes.find(
      (dish: { dish_revision_id: string }) => dish.dish_revision_id === firstRevisionId,
    );
    const suppressed = report.dishes.find(
      (dish: { dish_revision_id: string }) => dish.dish_revision_id === suppressedRevisionId,
    );
    if (!visible || !suppressed) throw new Error('Expected both revision cells in the report.');
    expect(visible.metrics).toMatchObject({
      consideration_sessions: { value: 10, status: 'NORMAL' },
      consideration_exposures: { value: 10, status: 'NORMAL' },
      open_rate: { value: null, status: 'SUPPRESSED' },
      save_rate: { value: null, status: 'SUPPRESSED' },
      verified_conversion_sessions: { value: null, status: 'MISSING' },
    });
    expect(suppressed.evidence_state).toBe('SUPPRESSED');
    for (const cell of Object.values(suppressed.metrics) as Array<{
      value: number | null;
      status: string;
    }>) {
      expect(cell).toEqual({ value: null, status: 'SUPPRESSED' });
    }
    expect(JSON.stringify(suppressed)).not.toMatch(/"value"\s*:\s*9\b/);

    const smallNumerator = report.dishes.find(
      (dish: { dish_revision_id: string }) => dish.dish_revision_id === smallNumeratorRevisionId,
    );
    const smallComplement = report.dishes.find(
      (dish: { dish_revision_id: string }) => dish.dish_revision_id === smallComplementRevisionId,
    );
    const boundary = report.dishes.find(
      (dish: { dish_revision_id: string }) => dish.dish_revision_id === boundaryRateRevisionId,
    );
    if (!smallNumerator || !smallComplement || !boundary) {
      throw new Error('Expected rate boundary revisions in the report.');
    }
    expect(smallNumerator.metrics).toMatchObject({
      consideration_sessions: { value: 20, status: 'NORMAL' },
      open_rate: { value: null, status: 'SUPPRESSED' },
    });
    expect(smallComplement.metrics.open_rate).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(boundary.metrics.open_rate).toEqual({ value: 0.5, status: 'NORMAL' });
  });

  it('requires a valid signed staff token and current venue membership', async () => {
    const app = createApp({
      verify,
      execute: async () => {
        throw new Error('Dish writes are not part of this test.');
      },
      readOwnerReport: async (actor, venue, query, env) => {
        const client = new Client({ connectionString: env.LOCAL_DATABASE_URL });
        await client.connect();
        try {
          return await readOwnerReport(client, actor, venue, query);
        } finally {
          await client.end();
        }
      },
    });
    const path = `/venues/${venueId}/owner-report?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
    expect(
      (
        await app.request(
          path,
          { headers: { Authorization: `Bearer ${await staffToken(crypto.randomUUID())}` } },
          { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl },
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request(path, {}, { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl })).status,
    ).toBe(401);
  });
});

async function staffToken(subject: string): Promise<string> {
  return new SignJWT({ role: 'authenticated', is_anonymous: false })
    .setProtectedHeader({ alg: 'ES256', kid: 'owner-report-test' })
    .setIssuer(issuer)
    .setAudience('authenticated')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function insertDishRevision(revisionId: string, version: number, name: string) {
  await admin.query(
    `INSERT INTO app_private.es_event
      (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload)
     VALUES ($1, $2, 'dish', $3, $4, 1, 'dish.revision.created', $5::jsonb)`,
    [
      crypto.randomUUID(),
      venueId,
      dishId,
      version,
      JSON.stringify({ dishId, revisionId, version, name, description: '' }),
    ],
  );
}

async function insertDisplayEvent(input: {
  eventId: string;
  sessionId: string;
  exposureId: string;
  revisionId: string;
  occurredAt: string;
}) {
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO app_private.observation_index
        (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type,
         authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition)
       VALUES ($1, $2, $3, 'observation.v2', 'dish_viewed', $4, $5, $6, $7, 'accepted')
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [
        venueId,
        input.eventId,
        'a'.repeat(64),
        publicationId,
        input.occurredAt,
        input.occurredAt,
        `synthetic/${venueId}/${input.eventId}`,
      ],
    );
    await admin.query(
      `INSERT INTO app_private.observation_event
        (tenant_id, event_id, event_type, session_id, producer_id, local_sequence,
         publication_revision_id, traffic_class)
       VALUES ($1, $2, 'dish_viewed', $3, $4, 0, $5, 'live')
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [venueId, input.eventId, input.sessionId, producerId, publicationId],
    );
    await admin.query(
      `INSERT INTO app_private.observation_exposure
        (tenant_id, event_id, dish_id, dish_revision_id, exposure_id, surface, position, exposure_basis)
       VALUES ($1, $2, $3, $4, $5, 'menu_list', 1, 'viewport_50pct_1s')
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [venueId, input.eventId, dishId, input.revisionId, input.exposureId],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

async function insertRevisionTraffic(revisionId: string, openedSessions: number) {
  for (let index = 0; index < 20; index++) {
    const sessionId = crypto.randomUUID();
    const exposureId = crypto.randomUUID();
    const occurredAt = `2026-11-06T${String(index).padStart(2, '0')}:45:00.000Z`;
    await insertDisplayEvent({
      eventId: crypto.randomUUID(),
      sessionId,
      exposureId,
      revisionId,
      occurredAt,
    });
    if (index < openedSessions) {
      await insertOpeningEvent({
        sessionId,
        exposureId,
        revisionId,
        occurredAt,
      });
    }
  }
}

async function insertOpeningEvent(input: {
  sessionId: string;
  exposureId: string;
  revisionId: string;
  occurredAt: string;
}) {
  const eventId = crypto.randomUUID();
  const openingId = crypto.randomUUID();
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO app_private.observation_index
        (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type,
         authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition)
       VALUES ($1, $2, $3, 'observation.v2', 'dish_detail_opened', $4, $5, $6, $7, 'accepted')`,
      [
        venueId,
        eventId,
        'b'.repeat(64),
        publicationId,
        input.occurredAt,
        input.occurredAt,
        `synthetic/${venueId}/${eventId}`,
      ],
    );
    await admin.query(
      `INSERT INTO app_private.observation_event
        (tenant_id, event_id, event_type, session_id, producer_id, local_sequence,
         publication_revision_id, traffic_class)
       VALUES ($1, $2, 'dish_detail_opened', $3, $4, 0, $5, 'live')`,
      [venueId, eventId, input.sessionId, producerId, publicationId],
    );
    await admin.query(
      `INSERT INTO app_private.observation_opening
        (tenant_id, event_id, dish_id, dish_revision_id, opening_id, source,
         from_exposure_id, save_available)
       VALUES ($1, $2, $3, $4, $5, 'menu_card', $6, false)`,
      [venueId, eventId, dishId, input.revisionId, openingId, input.exposureId],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

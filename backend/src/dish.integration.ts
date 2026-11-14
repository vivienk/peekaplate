import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import {
  DishRevisionSchema,
  ExtractionReviewSessionResponseSchema,
  MenuApprovalSchema,
  MenuPublicationSchema,
  ObservationReceiptBatchSchema,
  OwnerDishReportSchema,
  PublicMenuResponseSchema,
  ReviewCandidateItemResponseSchema,
  verifyPublicMenuContentBytes,
} from '@peekaplate/contracts';
import { chromium } from '@playwright/test';
import { createRemoteJWKSet, exportJWK, generateKeyPair, type JWK, jwtVerify, SignJWT } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev } from 'wrangler';
import { createStaffVerifier } from './auth';
import { produceMenuBundle } from './bundle-producer/produce';
import { admitMenuBundleHandoff, loadApprovedDishSources } from './bundle-producer/repository';
import { MenuBundleRequestSchema, T0AssetManifestSchema } from './bundle-producer/request';
import { createDishRevision, replayDish } from './dish-command';
import { type Bindings, createApp, SYNTHETIC_REPORT_VENUE_ALLOWLIST } from './index';
import { replayPublication, replayReview } from './publication-command';
import { verifyReviewArtifact } from './review-artifact';
import { upsertExtractionReviewSession } from './review-command';
import { readTeamAnalytics } from './team-analytics';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
if (!runtimeUrl || !adminUrl)
  throw new Error('Run pnpm verify test:db with its disposable database');
const admin = new Client({ connectionString: adminUrl });
const venue = SYNTHETIC_REPORT_VENUE_ALLOWLIST[0];
const otherVenue = crypto.randomUUID();
const actor = crypto.randomUUID();
const otherActor = crypto.randomUUID();
const viewer = crypto.randomUUID();
const otherVenueOwner = crypto.randomUUID();
let server: Server;
let env: Bindings;
let signingKey: CryptoKey;
let collaboratorEnabled = true;
const githubCalls: string[] = [];
let menuPublicJwk: JWK;
let menuSigningJwk: string;
let menuTokenIssuer: string;
let worker: Awaited<ReturnType<typeof unstable_dev>>;
const integrationConfig = fileURLToPath(
  new URL('../.wrangler/observation-integration.json', import.meta.url),
);

function command(patch = {}) {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion: 0,
    name: 'Test dish',
    description: 'Synthetic fixture',
    ...patch,
  };
}

async function token({ sub }: { sub: string }) {
  return new SignJWT({ role: 'authenticated', is_anonymous: false })
    .setProtectedHeader({ alg: 'ES256', kid: 'integration' })
    .setIssuer(env.AUTH_ISSUER!)
    .setAudience('authenticated')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

async function request(dishId: string, body = command(), tenant = venue, subject = actor) {
  return fetch(`http://127.0.0.1:${worker.port}/venues/${tenant}/dishes/${dishId}/revisions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token({ sub: subject })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function requestEvidence(
  body: unknown = { query: 'Tuscan White Bean Soup' },
  tenant = venue,
  subject = actor,
) {
  return fetch(`http://127.0.0.1:${worker.port}/venues/${tenant}/menu-evidence`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token({ sub: subject })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
const fixtureV2 = JSON.parse(
  readFileSync(
    new URL(
      '../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

async function requestPutSession(
  extractionId: string,
  body: unknown,
  tenant = venue,
  subject = actor,
) {
  return fetch(
    `http://127.0.0.1:${worker.port}/venues/${tenant}/extractions/${extractionId}/review-session`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await token({ sub: subject })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

async function requestGetCandidates(extractionId: string, tenant = venue, subject = actor) {
  return fetch(
    `http://127.0.0.1:${worker.port}/venues/${tenant}/extractions/${extractionId}/candidates`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${await token({ sub: subject })}`,
      },
    },
  );
}

async function requestCandidateReview(
  extractionId: string,
  candidateId: string,
  body: unknown,
  tenant = venue,
  subject = actor,
) {
  return fetch(
    `http://127.0.0.1:${worker.port}/venues/${tenant}/extractions/${extractionId}/candidates/${candidateId}/review`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await token({ sub: subject })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

async function requestPublication(
  menuId: string,
  action: 'approvals' | 'publications' | 'withdrawals',
  body: unknown,
  tenant = venue,
  subject = actor,
) {
  return fetch(`http://127.0.0.1:${worker.port}/venues/${tenant}/menus/${menuId}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token({ sub: subject })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function approvalCommand(expectedVersion = 0) {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion,
    menuRevisionId: crypto.randomUUID(),
    contentApprovalId: crypto.randomUUID(),
    assetApprovalId: crypto.randomUUID(),
  };
}

async function registerReviewSubject(
  menuId: string,
  input: ReturnType<typeof approvalCommand>,
  tenant = venue,
) {
  await admin.query(
    `INSERT INTO app_private.menu_review_subject
      (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash,
       asset_approval_id, asset_manifest_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tenant,
      menuId,
      input.menuRevisionId,
      input.contentApprovalId,
      'a'.repeat(64),
      input.assetApprovalId,
      'b'.repeat(64),
    ],
  );
}

async function registerPublicBundle(menuId: string, menuRevisionId: string, tenant = venue) {
  await admin.query(
    `INSERT INTO app_private.public_menu_bundle
      (tenant_id, menu_id, menu_revision_id, bundle_url)
     VALUES ($1, $2, $3, $4)`,
    [tenant, menuId, menuRevisionId, `https://assets.example.test/${menuRevisionId}.json`],
  );
}

async function requestPublicMenu(menuId: string, tenant = venue) {
  return fetch(`http://127.0.0.1:${worker.port}/public/venues/${tenant}/menus/${menuId}`);
}

async function publicationCounts(menuId: string) {
  const result = await admin.query(
    `SELECT
    (SELECT count(*)::int FROM app_private.es_event WHERE stream_id=$1) AS events,
    (SELECT count(*)::int FROM app_private.menu_approval WHERE menu_id=$1) AS approvals,
    (SELECT count(*)::int FROM app_private.menu_review_current WHERE menu_id=$1) AS reviews,
    (SELECT count(*)::int FROM app_private.menu_publication_current WHERE menu_id=$1) AS publications,
    (SELECT count(*)::int FROM app_private.es_command WHERE payload->>'menuId'=$1::text) AS receipts,
    (SELECT count(*)::int FROM app_private.outbox WHERE payload->>'menuId'=$1::text) AS outbox`,
    [menuId],
  );
  return result.rows[0];
}

async function counts(dishId: string) {
  const result = await admin.query(
    `SELECT
    (SELECT count(*)::int FROM app_private.es_event WHERE stream_id=$1) AS events,
    (SELECT count(*)::int FROM app_private.dish_current WHERE dish_id=$1) AS projections,
    (SELECT count(*)::int FROM app_private.es_command WHERE payload->>'dishId'=$1::text) AS receipts,
    (SELECT count(*)::int FROM app_private.outbox WHERE payload->>'dishId'=$1::text) AS outbox`,
    [dishId],
  );
  return result.rows[0];
}

beforeAll(async () => {
  await admin.connect();
  await admin.query('INSERT INTO app_private.venues (id,name) VALUES ($1,$3),($2,$3)', [
    venue,
    otherVenue,
    'Synthetic venue',
  ]);
  await admin.query(
    `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission)
    VALUES ($1,$3,'owner'),($1,$4,'editor'),($1,$5,'viewer'),($2,$4,'owner'),($2,$6,'owner')`,
    [venue, otherVenue, actor, otherActor, viewer, otherVenueOwner],
  );
  const keys = await generateKeyPair('ES256');
  signingKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'integration', alg: 'ES256' };
  const menuKeys = await generateKeyPair('ES256', { extractable: true });
  menuPublicJwk = {
    ...(await exportJWK(menuKeys.publicKey)),
    kid: 'menu-integration',
    alg: 'ES256',
    use: 'sig',
  };
  menuSigningJwk = JSON.stringify({
    ...(await exportJWK(menuKeys.privateKey)),
    kid: 'menu-integration',
    alg: 'ES256',
    use: 'sig',
  });
  server = createServer((req, res) => {
    githubCalls.push(req.url ?? '');
    if (req.url === '/user') {
      if (req.headers.authorization !== 'Bearer fixture-member') {
        res.writeHead(401).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ id: 42, login: 'fixture-member', type: 'User' }));
      return;
    }
    if (req.url === '/repos/vivienk/peekaplate/collaborators/fixture-member') {
      res
        .writeHead(
          req.headers.authorization === 'Bearer fixture-server' && collaboratorEnabled ? 204 : 404,
        )
        .end();
      return;
    }
    if (req.url === '/.well-known/jwks.json') {
      res
        .writeHead(200, { 'Content-Type': 'application/jwk-set+json' })
        .end(JSON.stringify({ keys: [menuPublicJwk] }));
      return;
    }
    if (req.url !== '/auth/v1/.well-known/jwks.json') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local JWKS listener');
  menuTokenIssuer = `http://127.0.0.1:${address.port}`;
  env = {
    APP_ENV: 'local',
    SYNTHETIC_REPORT_VENUE_ID: venue,
    AUTH_ISSUER: `http://127.0.0.1:${address.port}/auth/v1`,
    LOCAL_DATABASE_URL: runtimeUrl,
    MENU_TOKEN_ISSUER: menuTokenIssuer,
    MENU_TOKEN_SIGNING_JWK: menuSigningJwk,
  };
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  config.main = fileURLToPath(new URL('./index.ts', import.meta.url));
  config.r2_buckets = [
    { binding: 'OBSERVATION_ARCHIVE_BUCKET', bucket_name: 'local-observation-fixtures' },
    { binding: 'INGESTION_REPORTS_BUCKET', bucket_name: 'local-menu-workspace' },
  ];
  config.ratelimits = config.env.staging.ratelimits;
  config.queues = {
    producers: [
      { binding: 'OBSERVATION_QUEUE', queue: 'local-observation-fixtures' },
      { binding: 'INGESTION_QUEUE', queue: 'local-menu-workspace' },
    ],
    consumers: [
      {
        queue: 'local-observation-fixtures',
        max_batch_size: 10,
        max_batch_timeout: 1,
        max_retries: 1,
      },
    ],
  };
  await mkdir(fileURLToPath(new URL('../.wrangler/', import.meta.url)), { recursive: true });
  await writeFile(integrationConfig, JSON.stringify(config));
  worker = await unstable_dev(fileURLToPath(new URL('./index.ts', import.meta.url)), {
    config: integrationConfig,
    local: true,
    ip: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    logLevel: 'error',
    vars: {
      APP_ENV: 'local',
      SYNTHETIC_REPORT_VENUE_ID: venue,
      AUTH_ISSUER: env.AUTH_ISSUER!,
      LOCAL_DATABASE_URL: runtimeUrl!,
      POSTHOG_PROJECT_ID: '675372',
      MENU_TOKEN_ISSUER: menuTokenIssuer,
      MENU_TOKEN_SIGNING_JWK: menuSigningJwk,
      TEAM_GITHUB_TOKEN: 'fixture-server',
      LOCAL_GITHUB_API_URL: `http://127.0.0.1:${address.port}/`,
    },
    experimental: {
      disableExperimentalWarning: true,
      forceLocal: true,
      watch: false,
      disableDevRegistry: true,
    },
  });
});

afterAll(async () => {
  if (worker) await worker.stop();
  await unlink(integrationConfig).catch(() => {});
  await admin.end();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe('owner menu browser transport', () => {
  it('saves and resumes a private draft/photo through Chromium and the actual Worker/database', async () => {
    const browser = await chromium.launch();
    const consoleServer = createServer((_, res) =>
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<!doctype html><title>Synthetic owner workspace transport</title>'),
    );
    let ownsServer = false;
    await new Promise<void>((resolve, reject) => {
      consoleServer.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? resolve() : reject(error),
      );
      consoleServer.listen(5174, '127.0.0.1', () => {
        ownsServer = true;
        resolve();
      });
    });
    try {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:5174/workspace-check.html');
      const id = crypto.randomUUID();
      const bearer = await token({ sub: actor });
      const api = `http://127.0.0.1:${worker.port}`;
      const first = await page.evaluate(
        async ({ api, id, venue, bearer }) => {
          const response = await fetch(`${api}/venues/${venue}/drafts/${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              commandId: crypto.randomUUID(),
              expectedVersion: 0,
              fields: { name: 'Browser fictional soup' },
            }),
          });
          return {
            status: response.status,
            body: await response.json(),
          };
        },
        { api, id, venue, bearer },
      );
      expect(first.status).toBe(200);
      await page.reload();
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=',
        'base64',
      );
      const result = await page.evaluate(
        async ({ api, id, venue, otherVenue, bearer, png }) => {
          const headers = { Authorization: `Bearer ${bearer}` };
          const resumed = await fetch(`${api}/venues/${venue}/drafts/${id}`, { headers });
          const draft = (await resumed.json()) as {
            draft: { name: string; draft_version: number };
          };
          const uploaded = await fetch(`${api}/venues/${venue}/drafts/${id}/photos`, {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': 'image/png',
              'Idempotency-Key': crypto.randomUUID(),
            },
            body: new Uint8Array(png),
          });
          const photo = (await uploaded.json()) as { photo: { id: string } };
          const read = await fetch(`${api}/venues/${venue}/drafts/${id}/photos/${photo.photo.id}`, {
            headers,
          });
          const denied = await fetch(`${api}/venues/${otherVenue}/drafts/${id}`, { headers });
          const anonymous = await fetch(`${api}/venues/${venue}/drafts/${id}`);
          return {
            resumed: resumed.status,
            name: draft.draft.name,
            version: draft.draft.draft_version,
            upload: uploaded.status,
            photo: read.status,
            type: read.headers.get('content-type'),
            size: (await read.arrayBuffer()).byteLength,
            denied: denied.status,
            anonymous: anonymous.status,
          };
        },
        { api, id, venue, otherVenue, bearer, png: [...png] },
      );
      expect(result).toEqual({
        resumed: 200,
        name: 'Browser fictional soup',
        version: 1,
        upload: 201,
        photo: 200,
        type: 'image/png',
        size: png.length,
        denied: 403,
        anonymous: 401,
      });
    } finally {
      await browser.close();
      if (ownsServer) await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
    }
  });
});

describe('real team analytics API', () => {
  const window = '?from=2026-10-20T06:00:00Z&until=2026-10-20T07:00:00Z';
  it('returns bounded redacted staging data and denies other actors/projects and revoked access', async () => {
    await admin.query(`INSERT INTO analytics_private.posthog_events(uuid,event,properties,team_id,timestamp,distinct_id,ip)
      SELECT 'team-fixture-' || n, 'app_shell_viewed',
        '{"environment":"staging","surface":"diner","schema_version":1,"private":"hidden"}'::jsonb,
        675372, '2026-10-20T06:30:00Z'::timestamptz, 'hidden-person', '127.0.0.1'
      FROM generate_series(1,3) n, generate_series(1,2) copies`);
    await admin.query(`INSERT INTO analytics_private.posthog_events(uuid,event,properties,team_id,timestamp)
      VALUES ('other-project','app_shell_viewed','{"environment":"staging","surface":"diner"}',2,'2026-10-20T06:30:00Z'),
      ('production','app_shell_viewed','{"environment":"production","surface":"diner"}',675372,'2026-10-20T06:30:00Z')`);
    const get = async (kind: string, subject = actor, suffix = '') =>
      fetch(`http://127.0.0.1:${worker.port}/team/analytics/${kind}${window}${suffix}`, {
        headers: {
          Authorization: `Bearer ${subject === actor ? 'fixture-member' : 'fixture-outsider'}`,
        },
      });
    const response = await get('events', actor, '&limit=2');
    expect(response.status, `Fixture paths: ${githubCalls.join(',')}`).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as { events: unknown[]; truncated: boolean };
    expect(body.events).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/hidden|127\.0\.0\.1|distinct_id|person_properties/);
    const summary = await get('summary');
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      counts: [{ event: 'app_shell_viewed', surface: 'diner', count: 3 }],
      events: [],
    });
    await admin.query(`INSERT INTO analytics_private.posthog_events(uuid,event,properties,team_id,timestamp)
      VALUES ('valid-dish','dish_open',jsonb_build_object('environment','staging','surface','diner',
        'event_id','00000000-0000-4000-8000-000000000001','publication_hash',repeat('a',64),
        'dish_revision_hash',repeat('b',64),'manifest_hash',repeat('c',64),'displayed_tier','T1',
        'availability_version',42),675372,'2026-10-20T06:35:00Z')`);
    const dishResponse = await get('events');
    expect(dishResponse.status).toBe(200);
    expect(await dishResponse.json()).toMatchObject({
      events: [
        {
          event: 'dish_open',
          properties: {
            availability_version: 42,
            displayed_tier: 'T1',
            publication_hash: 'a'.repeat(64),
            event_id: '00000000-0000-4000-8000-000000000001',
          },
        },
        {},
        {},
        {},
      ],
    });
    expect((await get('events', viewer)).status).toBe(401);
    expect((await get('events', actor, '&projectId=2')).status).toBe(400);
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      await expect(
        readTeamAnalytics(client, 2, 'events', {
          from: '2026-10-20T06:00:00Z',
          until: '2026-10-20T07:00:00Z',
          limit: 50,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(
        (await client.query("SELECT current_setting('app.actor_id',true) AS actor")).rows[0]
          .actor ?? '',
      ).toBe('');
    } finally {
      await client.end();
    }
    collaboratorEnabled = false;
    expect((await get('summary')).status).toBe(403);
  });
});

describe('real PostgreSQL staff command', () => {
  it('persists event, projection, receipt and outbox together with real JWT verification', async () => {
    const dish = crypto.randomUUID();
    const response = await request(dish);
    expect(response.status).toBe(200);
    const result = DishRevisionSchema.parse(await response.json());
    expect(result).toMatchObject({ dishId: dish, version: 1, name: 'Test dish' });
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
    const persisted = await admin.query(
      'SELECT revision_id,version FROM app_private.dish_current WHERE tenant_id=$1 AND dish_id=$2',
      [venue, dish],
    );
    expect(persisted.rows[0]).toEqual({ revision_id: result.revisionId, version: result.version });
  });
  it('returns the original receipt for an identical retry, without writing twice', async () => {
    const dish = crypto.randomUUID();
    const input = command();
    const first = await request(dish, input);
    const retry = await request(dish, input);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
  });
  it('rejects command identity reuse with different content or a different dish', async () => {
    const dish = crypto.randomUUID();
    const input = command();
    expect((await request(dish, input)).status).toBe(200);
    for (const [id, body] of [
      [dish, { ...input, name: 'Changed' }],
      [crypto.randomUUID(), input],
    ] as const) {
      const response = await request(id, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'command_conflict' });
    }
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
  });
  it('denies a forged venue and read-only staff, leaving no writes', async () => {
    const dish = crypto.randomUUID();
    expect((await request(dish, command(), otherVenue)).status).toBe(403);
    expect((await request(dish, command(), venue, viewer)).status).toBe(403);
    expect(await counts(dish)).toEqual({ events: 0, projections: 0, receipts: 0, outbox: 0 });
  });
  it('reauthorizes identical retries after membership revocation', async () => {
    const dish = crypto.randomUUID();
    const input = command();
    const revokedActor = crypto.randomUUID();
    await admin.query(
      "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES ($1,$2,'editor')",
      [venue, revokedActor],
    );
    expect((await request(dish, input, venue, revokedActor)).status).toBe(200);
    await admin.query(
      'DELETE FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2',
      [venue, revokedActor],
    );
    expect((await request(dish, input, venue, revokedActor)).status).toBe(403);
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
  });
  it('serializes concurrent first revisions from different staff: one succeeds and one conflicts', async () => {
    const dish = crypto.randomUUID();
    const responses = await Promise.all([
      request(dish),
      request(dish, command(), venue, otherActor),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
  });
  it('serializes concurrent updates with the same expected version', async () => {
    const dish = crypto.randomUUID();
    expect((await request(dish)).status).toBe(200);
    const responses = await Promise.all([
      request(dish, command({ expectedVersion: 1, name: 'Version two A' })),
      request(dish, command({ expectedVersion: 1, name: 'Version two B' }), venue, otherActor),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await counts(dish)).toEqual({ events: 2, projections: 1, receipts: 2, outbox: 2 });
  });
  it('coalesces simultaneous identical retries to the same committed result', async () => {
    const dish = crypto.randomUUID();
    const input = command();
    const responses = await Promise.all([request(dish, input), request(dish, input)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
  });
  it('rejects simultaneous conflicting payloads sharing a command identity', async () => {
    const dish = crypto.randomUUID();
    const input = command();
    const responses = await Promise.all([
      request(dish, input),
      request(dish, { ...input, name: 'Conflicting content' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
  });
  it('rolls back an event when its database connection dies before projection commit', async () => {
    const dish = crypto.randomUUID();
    expect((await request(dish)).status).toBe(200);
    const client = new Client({ connectionString: runtimeUrl });
    client.on('error', () => {});
    await client.connect();
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const input = { ...command({ expectedVersion: 1, name: 'After crash' }), dishId: dish };
    let transaction: Promise<unknown> | undefined;
    await admin.query('BEGIN');
    try {
      await admin.query(
        'SELECT 1 FROM app_private.dish_current WHERE tenant_id=$1 AND dish_id=$2 FOR UPDATE',
        [venue, dish],
      );
      transaction = createDishRevision(client, actor, venue, input).then(
        () => 'unexpected success',
        (error: unknown) => error,
      );
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        blocked =
          (await admin.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]))
            .rows[0]?.blocked === true;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      expect(await transaction).toBeInstanceOf(Error);
    } finally {
      await admin.query('ROLLBACK');
      await transaction;
      await client.end();
    }
    expect(await counts(dish)).toEqual({ events: 1, projections: 1, receipts: 1, outbox: 1 });
    expect((await request(dish, input)).status).toBe(400);
    const { dishId: _dishId, ...body } = input;
    expect((await request(dish, body)).status).toBe(200);
    expect(await counts(dish)).toEqual({ events: 2, projections: 1, receipts: 2, outbox: 2 });
  });
  it('rolls back all preceding writes if the final outbox insert fails, then permits retry', async () => {
    const dish = crypto.randomUUID();
    const input = command();
    await admin.query(
      `ALTER TABLE app_private.outbox ADD CONSTRAINT local_fault CHECK (payload->>'dishId' <> '${dish}')`,
    );
    try {
      const response = await request(dish, input);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'service_unavailable' });
      expect(await counts(dish)).toEqual({ events: 0, projections: 0, receipts: 0, outbox: 0 });
    } finally {
      await admin.query('ALTER TABLE app_private.outbox DROP CONSTRAINT local_fault');
    }
    expect((await request(dish, input)).status).toBe(200);
  });
  it('replays the persisted event stream to the live projection without writing side effects', async () => {
    const dish = crypto.randomUUID();
    expect((await request(dish)).status).toBe(200);
    expect(
      (await request(dish, command({ expectedVersion: 1, name: 'Updated dish' }))).status,
    ).toBe(200);
    const before = await counts(dish);
    const events = await admin.query(
      `SELECT tenant_id AS "tenantId",stream_type AS "streamType",stream_id AS "streamId",
      version,schema_version AS "schemaVersion",event_type AS "eventType",payload,metadata
      FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2 ORDER BY version`,
      [venue, dish],
    );
    const current = await admin.query(
      `SELECT tenant_id AS "tenantId",dish_id AS "dishId",revision_id AS "revisionId",version,name,description
      FROM app_private.dish_current WHERE tenant_id=$1 AND dish_id=$2`,
      [venue, dish],
    );
    expect(replayDish(events.rows)).toEqual(current.rows[0]);
    expect(await counts(dish)).toEqual(before);
  });
  it('clears transaction context after commit and rollback on a reused physical connection', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      await createDishRevision(client, actor, venue, { ...command(), dishId: crypto.randomUUID() });
      expect((await client.query('SELECT * FROM app_private.dish_current')).rows).toEqual([]);
      expect((await client.query('SELECT * FROM app_private.staff_membership')).rows).toEqual([]);
      await expect(
        createDishRevision(client, actor, otherVenue, {
          ...command(),
          dishId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect((await client.query('SELECT * FROM app_private.dish_current')).rows).toEqual([]);
      expect((await client.query('SELECT * FROM app_private.staff_membership')).rows).toEqual([]);
      const result = await createDishRevision(client, otherActor, otherVenue, {
        ...command(),
        dishId: crypto.randomUUID(),
      });
      expect(result.version).toBe(1);
      expect((await client.query('SELECT * FROM app_private.dish_current')).rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  describe('Finding P1: menu evidence database authorization under restricted database role', () => {
    it('authorizes a valid venue owner with 200 under restricted database role', async () => {
      const response = await requestEvidence({ query: 'Tuscan White Bean Soup' });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toHaveProperty('schema_version', 1);
    });

    it('authorizes a valid editor with 200 under restricted database role', async () => {
      const editorActor = crypto.randomUUID();
      await admin.query(
        "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES ($1,$2,'editor')",
        [venue, editorActor],
      );
      try {
        const response = await requestEvidence(
          { query: 'Tuscan White Bean Soup' },
          venue,
          editorActor,
        );
        expect(response.status).toBe(200);
      } finally {
        await admin.query(
          'DELETE FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2',
          [venue, editorActor],
        );
      }
    });

    it('denies a viewer with 403 under restricted database role', async () => {
      const response = await requestEvidence({ query: 'Tuscan White Bean Soup' }, venue, viewer);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    });

    it('denies an actor from another venue with 403', async () => {
      const response = await requestEvidence(
        { query: 'Tuscan White Bean Soup' },
        otherVenue,
        actor,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    });

    it('rejects a body-supplied venue ID mismatch with 400 invalid_request', async () => {
      const response = await requestEvidence({
        query: 'Tuscan White Bean Soup',
        venue_id: otherVenue,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it('does not leak transaction-local actor context to subsequent requests on the same connection', async () => {
      // First request: valid owner succeeds
      const res1 = await requestEvidence({ query: 'Tuscan White Bean Soup' }, venue, actor);
      expect(res1.status).toBe(200);

      // Second request: nonmember fails with 403
      const nonmember = crypto.randomUUID();
      const res2 = await requestEvidence({ query: 'Tuscan White Bean Soup' }, venue, nonmember);
      expect(res2.status).toBe(403);
    });
  });

  describe('S3-RES-01.2 review candidate persistence staging journey', () => {
    const reviewExtractionId = fixtureV2.extraction_id;
    const soupCandidateId = 'draft:0bbe00087c6841623c76d7b6f9da5ebf';
    const coffeeCandidateId = 'draft:0ff0863ef48b2db591694fcc3c35fbb0';
    const breadCandidateId = 'draft:6dbe8d78dae3c41e819deed5267f8149';

    it('rejects changed source provenance before persistence and reloads the honest producer source', async () => {
      const report = JSON.parse(
        readFileSync(
          new URL(
            '../../processing/tests/fixtures/review-candidates/representative-extraction-v2.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      for (const [field, value] of [
        ['location', 'invented-other-menu.pdf'],
        ['kind', 'website'],
        ['retrieved_at', '2026-10-26T12:00:00Z'],
        ['size_bytes', 999],
      ] as const) {
        const reviewVenue = crypto.randomUUID();
        const jobId = crypto.randomUUID();
        const attemptId = crypto.randomUUID();
        await admin.query('INSERT INTO app_private.venues(id,name) VALUES ($1,$2)', [
          reviewVenue,
          'Synthetic provenance check',
        ]);
        await admin.query(
          "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES ($1,$2,'owner')",
          [reviewVenue, actor],
        );
        const key = `menu-ingestion/review-artifacts/${reviewVenue}/${jobId}/${attemptId}/bundle.json`;
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            report,
            scope: {
              tenant_id: reviewVenue,
              job_id: jobId,
              attempt_id: attemptId,
              source_hash: report.source.sha256,
            },
          }),
        );
        const app = createApp({
          verify: createStaffVerifier({ issuer: env.AUTH_ISSUER!, allowLocalIssuer: true }),
          execute: async () => {
            throw new Error('Unexpected dish command in provenance test');
          },
          async upsertReviewSession(actorId, venueId, input) {
            await verifyReviewArtifact({
              appEnv: 'staging',
              venueId,
              input,
              read: async (requested) =>
                requested === key
                  ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }
                  : null,
            });
            const client = new Client({ connectionString: runtimeUrl });
            try {
              await client.connect();
              return await upsertExtractionReviewSession(client, actorId, venueId, input);
            } finally {
              await client.end();
            }
          },
        });
        const authorization = `Bearer ${await token({ sub: actor })}`;
        const url = `http://localhost/venues/${reviewVenue}/extractions/${fixtureV2.extraction_id}/review-session`;
        const put = (extractionResult: unknown) =>
          app.request(
            url,
            {
              method: 'PUT',
              headers: { Authorization: authorization, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                commandId: crypto.randomUUID(),
                extractionResult,
                jobId,
                privateArtifactRef: {
                  schema_version: 1,
                  key,
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                },
              }),
            },
            env,
          );
        const altered = structuredClone(fixtureV2);
        altered.source[field] = value;
        const denied = await put(altered);
        expect(denied.status).toBe(409);
        expect(await denied.json()).toEqual({ error: 'artifact_mismatch' });
        expect(
          (
            await admin.query(
              'SELECT count(*)::int AS count FROM app_private.extraction_review_session WHERE tenant_id=$1',
              [reviewVenue],
            )
          ).rows[0].count,
        ).toBe(0);
        expect((await put(fixtureV2)).status).toBe(200);
        const reload = await requestGetCandidates(fixtureV2.extraction_id, reviewVenue, actor);
        expect(reload.status).toBe(200);
        expect(
          ((await reload.json()) as { extractionResult: typeof fixtureV2 }).extractionResult.source,
        ).toEqual(fixtureV2.source);
      }
    });

    it('registers review session, reloads pending state, corrects, marks incomplete, rejects, and verifies persistence and publication isolation', async () => {
      const reviewVenue = crypto.randomUUID();
      await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
        reviewVenue,
        'Review Venue',
      ]);
      await admin.query(
        "INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')",
        [reviewVenue, actor, viewer],
      );

      const sessionCommandId = crypto.randomUUID();
      const putRes = await requestPutSession(
        reviewExtractionId,
        {
          commandId: sessionCommandId,
          extractionResult: fixtureV2,
        },
        reviewVenue,
        actor,
      );
      expect(putRes.status).toBe(200);
      const sessionData = (await putRes.json()) as {
        schemaVersion: number;
        venueId: string;
        items: unknown[];
        published: boolean;
      };
      expect(sessionData.schemaVersion).toBe(1);
      expect(sessionData.venueId).toBe(reviewVenue);
      expect(sessionData.published).toBe(false);
      expect(sessionData.items).toHaveLength(3);

      // Idempotent reload on PUT
      const putRetry = await requestPutSession(
        reviewExtractionId,
        {
          commandId: sessionCommandId,
          extractionResult: fixtureV2,
        },
        reviewVenue,
        actor,
      );
      expect(putRetry.status).toBe(200);
      expect(await putRetry.json()).toEqual(sessionData);

      // Initial reload via GET
      const getRes1 = await requestGetCandidates(reviewExtractionId, reviewVenue, actor);
      expect(getRes1.status).toBe(200);
      const getData1 = (await getRes1.json()) as {
        items: Array<{
          candidate: {
            candidate_id: string;
            original: { name: string; price_amount: string | null };
          };
          review: { reviewStatus: string; version: number; publishable: boolean };
          effective: { name: string };
        }>;
        published: boolean;
      };
      expect(getData1.published).toBe(false);
      expect(getData1.items).toHaveLength(3);
      for (const item of getData1.items) {
        expect(item.review.reviewStatus).toBe('pending');
        expect(item.review.version).toBe(0);
        expect(item.review.publishable).toBe(false);
      }

      // Action 1: Correct Garden Soup
      const cmd1Id = crypto.randomUUID();
      const correctRes = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: cmd1Id,
          expectedVersion: 0,
          action: 'correct',
          corrected: {
            name: 'Organic Garden Soup',
            price_amount: '9.50',
          },
        },
        reviewVenue,
        actor,
      );
      expect(correctRes.status).toBe(200);
      const correctData = (await correctRes.json()) as {
        candidate: { original: { name: string; price_amount: string | null } };
        review: {
          reviewStatus: string;
          version: number;
          editedFields: string[];
          reviewedBy: string;
        };
        effective: { name: string; price_amount: string };
      };
      expect(correctData.review.version).toBe(1);
      expect(correctData.review.reviewStatus).toBe('corrected');
      expect(correctData.review.editedFields).toEqual(['name', 'price_amount']);
      expect(correctData.review.reviewedBy).toBe(actor);
      // Original values are immutable!
      expect(correctData.candidate.original.name).toBe('Garden Soup');
      expect(correctData.candidate.original.price_amount).toBeNull();
      // Effective reflects correction
      expect(correctData.effective.name).toBe('Organic Garden Soup');
      expect(correctData.effective.price_amount).toBe('9.50');

      // Action 2: Mark Incomplete Coffee
      const cmd2Id = crypto.randomUUID();
      const incompleteRes = await requestCandidateReview(
        reviewExtractionId,
        coffeeCandidateId,
        {
          commandId: cmd2Id,
          expectedVersion: 0,
          action: 'mark_incomplete',
          incompleteFields: ['price_amount', 'description'],
          reviewNote: 'Confirm espresso size pricing with kitchen',
        },
        reviewVenue,
        actor,
      );
      expect(incompleteRes.status).toBe(200);
      const incompleteData = (await incompleteRes.json()) as {
        review: {
          reviewStatus: string;
          version: number;
          incompleteFields: string[];
          reviewNote: string;
        };
      };
      expect(incompleteData.review.version).toBe(1);
      expect(incompleteData.review.reviewStatus).toBe('incomplete');
      expect(incompleteData.review.incompleteFields).toEqual(['price_amount', 'description']);
      expect(incompleteData.review.reviewNote).toBe('Confirm espresso size pricing with kitchen');

      // Action 3: Reject Bread
      const cmd3Id = crypto.randomUUID();
      const rejectRes = await requestCandidateReview(
        reviewExtractionId,
        breadCandidateId,
        {
          commandId: cmd3Id,
          expectedVersion: 0,
          action: 'reject',
          reviewNote: 'Complimentary table bread, not a standalone menu item',
        },
        reviewVenue,
        actor,
      );
      expect(rejectRes.status).toBe(200);
      const rejectData = (await rejectRes.json()) as {
        review: {
          reviewStatus: string;
          version: number;
          editedFields: string[];
          reviewNote: string;
        };
      };
      expect(rejectData.review.version).toBe(1);
      expect(rejectData.review.reviewStatus).toBe('rejected');
      expect(rejectData.review.editedFields).toEqual([]);
      expect(rejectData.review.reviewNote).toBe(
        'Complimentary table bread, not a standalone menu item',
      );

      // Reload via GET: all states persist consistently
      const getRes2 = await requestGetCandidates(reviewExtractionId, reviewVenue, actor);
      expect(getRes2.status).toBe(200);
      const getData2 = (await getRes2.json()) as {
        items: Array<{
          candidate: { candidate_id: string; original: { name: string } };
          review: { reviewStatus: string; version: number; reviewedBy: string };
          effective: { name: string; price_amount?: string | null };
        }>;
        published: boolean;
      };
      expect(getData2.published).toBe(false);

      const soupItem = getData2.items.find((i) => i.candidate.candidate_id === soupCandidateId);
      expect(soupItem?.review.reviewStatus).toBe('corrected');
      expect(soupItem?.review.version).toBe(1);
      expect(soupItem?.candidate.original.name).toBe('Garden Soup');
      expect(soupItem?.effective.name).toBe('Organic Garden Soup');
      expect(soupItem?.effective.price_amount).toBe('9.50');
      expect(soupItem?.review.reviewedBy).toBe(actor);

      const coffeeItem = getData2.items.find((i) => i.candidate.candidate_id === coffeeCandidateId);
      expect(coffeeItem?.review.reviewStatus).toBe('incomplete');
      expect(coffeeItem?.review.version).toBe(1);

      const breadItem = getData2.items.find((i) => i.candidate.candidate_id === breadCandidateId);
      expect(breadItem?.review.reviewStatus).toBe('rejected');
      expect(breadItem?.review.version).toBe(1);

      // Idempotent retry on correction
      const retryRes = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: cmd1Id,
          expectedVersion: 0,
          action: 'correct',
          corrected: {
            name: 'Organic Garden Soup',
            price_amount: '9.50',
          },
        },
        reviewVenue,
        actor,
      );
      expect(retryRes.status).toBe(200);
      expect(await retryRes.json()).toEqual(correctData);

      // Stale expectedVersion conflict
      const staleRes = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: crypto.randomUUID(),
          expectedVersion: 0, // current is 1
          action: 'correct',
          corrected: { name: 'Another Soup' },
        },
        reviewVenue,
        actor,
      );
      expect(staleRes.status).toBe(409);
      expect(await staleRes.json()).toEqual({ error: 'version_conflict' });

      // Concurrent update race with expectedVersion: 1
      const raceCmdA = crypto.randomUUID();
      const raceCmdB = crypto.randomUUID();
      const [raceResA, raceResB] = await Promise.all([
        requestCandidateReview(
          reviewExtractionId,
          soupCandidateId,
          {
            commandId: raceCmdA,
            expectedVersion: 1,
            action: 'correct',
            corrected: { name: 'Winner A Soup' },
          },
          reviewVenue,
          actor,
        ),
        requestCandidateReview(
          reviewExtractionId,
          soupCandidateId,
          {
            commandId: raceCmdB,
            expectedVersion: 1,
            action: 'correct',
            corrected: { name: 'Winner B Soup' },
          },
          reviewVenue,
          actor,
        ),
      ]);

      const statuses = [raceResA.status, raceResB.status].sort();
      expect(statuses).toEqual([200, 409]);
      const conflictRes = raceResA.status === 409 ? raceResA : raceResB;
      expect(await conflictRes.json()).toEqual({ error: 'version_conflict' });

      // Tenant isolation and role denial
      // 1. Other venue owner (with no membership on reviewVenue) cannot read or mutate reviewVenue's extraction
      const otherVenueActor = crypto.randomUUID();
      await admin.query(
        "INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, 'owner')",
        [otherVenue, otherVenueActor],
      );
      const otherVenueGet = await requestGetCandidates(
        reviewExtractionId,
        reviewVenue,
        otherVenueActor,
      );
      expect(otherVenueGet.status).toBe(403);
      expect(await otherVenueGet.json()).toEqual({ error: 'forbidden' });

      const otherVenuePost = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: crypto.randomUUID(),
          expectedVersion: 2,
          action: 'correct',
          corrected: { name: 'Hack' },
        },
        reviewVenue,
        otherVenueActor,
      );
      expect(otherVenuePost.status).toBe(403);
      expect(await otherVenuePost.json()).toEqual({ error: 'forbidden' });

      // 2. Viewer on reviewVenue cannot mutate
      const viewerPost = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: crypto.randomUUID(),
          expectedVersion: 2,
          action: 'correct',
          corrected: { name: 'Viewer Edit' },
        },
        reviewVenue,
        viewer,
      );
      expect(viewerPost.status).toBe(403);
      expect(await viewerPost.json()).toEqual({ error: 'forbidden' });

      // Zero implicit publication: app_private.dish_current and dish stream events MUST be 0
      const dishCurrentRows = await admin.query<{ count: string }>(
        'SELECT count(*)::int AS count FROM app_private.dish_current WHERE tenant_id = $1',
        [reviewVenue],
      );
      expect(Number(dishCurrentRows.rows[0]?.count)).toBe(0);

      const dishEventRows = await admin.query<{ count: string }>(
        "SELECT count(*)::int AS count FROM app_private.es_event WHERE tenant_id = $1 AND stream_type = 'dish'",
        [reviewVenue],
      );
      expect(Number(dishEventRows.rows[0]?.count)).toBe(0);

      // Verify exactly 4 candidate_review events were created in total
      const candidateReviewEvents = await admin.query<{ count: string }>(
        "SELECT count(*)::int AS count FROM app_private.es_event WHERE tenant_id = $1 AND stream_type = 'candidate_review'",
        [reviewVenue],
      );
      expect(Number(candidateReviewEvents.rows[0]?.count)).toBe(4);
    });

    async function registeredReviewVenue() {
      const reviewVenue = crypto.randomUUID();
      await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $2)', [
        reviewVenue,
        'Review Venue',
      ]);
      await admin.query(
        "INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES ($1, $2, 'owner')",
        [reviewVenue, actor],
      );
      const put = await requestPutSession(
        reviewExtractionId,
        { commandId: crypto.randomUUID(), extractionResult: fixtureV2 },
        reviewVenue,
        actor,
      );
      expect(put.status).toBe(200);
      return reviewVenue;
    }

    it('T-DB-1 withdraws a correction when its field is marked incomplete and reloads the same state', async () => {
      const reviewVenue = await registeredReviewVenue();
      const corrected = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: crypto.randomUUID(),
          expectedVersion: 0,
          action: 'correct',
          corrected: { price_amount: '9.50', name: 'Organic Garden Soup' },
        },
        reviewVenue,
        actor,
      );
      expect(corrected.status).toBe(200);
      const incomplete = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: crypto.randomUUID(),
          expectedVersion: 1,
          action: 'mark_incomplete',
          incompleteFields: ['price_amount'],
        },
        reviewVenue,
        actor,
      );
      expect(incomplete.status).toBe(200);
      const saved = ReviewCandidateItemResponseSchema.parse(await incomplete.json());
      expect(saved.review).toMatchObject({
        version: 2,
        reviewStatus: 'incomplete',
        corrected: { name: 'Organic Garden Soup' },
        editedFields: ['name'],
        incompleteFields: ['price_amount'],
      });
      expect(saved.review.corrected).toEqual({ name: 'Organic Garden Soup' });
      expect(saved.effective.price_amount).toBeNull();

      const reload = await requestGetCandidates(reviewExtractionId, reviewVenue, actor);
      const { items } = ExtractionReviewSessionResponseSchema.parse(await reload.json());
      const soup = items.find((item) => item.candidate.candidate_id === soupCandidateId);
      expect(soup?.review).toEqual(saved.review);
      expect(soup?.effective).toEqual(saved.effective);

      const overlap = await requestCandidateReview(
        reviewExtractionId,
        soupCandidateId,
        {
          commandId: crypto.randomUUID(),
          expectedVersion: 2,
          action: 'mark_incomplete',
          corrected: { price_amount: '9.50' },
          incompleteFields: ['price_amount'],
        },
        reviewVenue,
        actor,
      );
      expect(overlap.status).toBe(400);
      expect(await overlap.json()).toEqual({ error: 'invalid_candidate' });
      const events = await admin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM app_private.es_event WHERE tenant_id = $1 AND stream_type = 'candidate_review'",
        [reviewVenue],
      );
      expect(events.rows[0]?.count).toBe(2);
    });

    it('T-DB-2 keeps an omitted note, conflicts on null reuse of the same commandId, and clears on a new null command', async () => {
      const reviewVenue = await registeredReviewVenue();
      const save = (body: Record<string, unknown>) =>
        requestCandidateReview(reviewExtractionId, soupCandidateId, body, reviewVenue, actor);
      expect(
        (
          await save({
            commandId: crypto.randomUUID(),
            expectedVersion: 0,
            action: 'correct',
            corrected: { name: 'Organic Garden Soup' },
            reviewNote: 'Retained note',
          })
        ).status,
      ).toBe(200);
      const omittedCommand = {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        action: 'correct',
        corrected: { price_amount: '9.50' },
      };
      const omitted = await save(omittedCommand);
      expect(omitted.status).toBe(200);
      const omittedBody = ReviewCandidateItemResponseSchema.parse(await omitted.json());
      expect(omittedBody.review.reviewNote).toBe('Retained note');

      const reusedWithNull = await save({ ...omittedCommand, reviewNote: null });
      expect(reusedWithNull.status).toBe(409);
      expect(await reusedWithNull.json()).toEqual({ error: 'command_conflict' });

      const retry = await save(omittedCommand);
      expect(retry.status).toBe(200);
      expect(ReviewCandidateItemResponseSchema.parse(await retry.json())).toEqual(omittedBody);

      const cleared = await save({
        commandId: crypto.randomUUID(),
        expectedVersion: 2,
        action: 'correct',
        corrected: { price_amount: '9.50' },
        reviewNote: null,
      });
      expect(cleared.status).toBe(200);
      const reload = ExtractionReviewSessionResponseSchema.parse(
        await (await requestGetCandidates(reviewExtractionId, reviewVenue, actor)).json(),
      );
      const soup = reload.items.find((item) => item.candidate.candidate_id === soupCandidateId);
      expect(soup?.review.version).toBe(3);
      expect(soup?.review.reviewNote).toBeNull();
    });
  });
});

describe('real PostgreSQL menu publication commands', () => {
  it('allocates distinct restaurant links atomically, preserving retries and closing withdrawn links', async () => {
    const restaurantName = `URL fixture ${crypto.randomUUID().slice(0, 8)}`;
    const tenants = [crypto.randomUUID(), crypto.randomUUID()];
    const menus = [crypto.randomUUID(), crypto.randomUUID()];
    const commands: Array<{ commandId: string; expectedVersion: number; approvalId: string }> = [];
    for (const [index, tenant] of tenants.entries()) {
      const menu = menus[index]!;
      await admin.query('INSERT INTO app_private.venues(id,name) VALUES ($1,$2)', [
        tenant,
        restaurantName,
      ]);
      await admin.query(
        "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES ($1,$2,'owner')",
        [tenant, actor],
      );
      const input = approvalCommand();
      await registerReviewSubject(menu, input, tenant);
      await registerPublicBundle(menu, input.menuRevisionId, tenant);
      const approval = await requestPublication(menu, 'approvals', input, tenant);
      const approved = MenuApprovalSchema.parse(await approval.json());
      commands.push({
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        approvalId: approved.approvalId,
      });
    }
    const responses = await Promise.all(
      tenants.map((tenant, index) =>
        requestPublication(menus[index]!, 'publications', commands[index], tenant),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const paths = responses.map((response) => response.headers.get('Location'));
    expect(new Set(paths).size).toBe(2);
    for (const path of paths)
      expect(path).toMatch(/^http:\/\/127\.0\.0\.1:5186\/diner\/url_fixture_[a-z0-9_]+$/);
    const expected = await responses[0]!.json();
    const again = await requestPublication(menus[0]!, 'publications', commands[0], tenants[0]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(expected);
    expect(again.headers.get('Location')).toBe(paths[0]);
    const slug = paths[0]!.split('/').at(-1)!;
    const resolve = () => fetch(`http://127.0.0.1:${worker.port}/public/restaurants/${slug}`);
    expect(await (await resolve()).json()).toEqual({ venueId: tenants[0], menuId: menus[0] });
    const ownerLink = `/venues/${tenants[0]}/menus/${menus[0]}/diner-link`;
    expect((await fetch(`http://127.0.0.1:${worker.port}${ownerLink}`)).status).toBe(401);
    const denied = await fetch(`http://127.0.0.1:${worker.port}${ownerLink}`, {
      headers: { Authorization: `Bearer ${await token({ sub: otherVenueOwner })}` },
    });
    expect(denied.status).toBe(403);
    await admin.query('UPDATE app_private.venues SET name=$2 WHERE id=$1', [
      tenants[0],
      'Renamed restaurant',
    ]);
    expect(
      (
        await requestPublication(
          menus[0]!,
          'withdrawals',
          { commandId: crypto.randomUUID(), expectedVersion: 1 },
          tenants[0],
        )
      ).status,
    ).toBe(200);
    expect((await resolve()).status).toBe(404);
    const republish = await requestPublication(
      menus[0]!,
      'publications',
      { ...commands[0]!, commandId: crypto.randomUUID(), expectedVersion: 2 },
      tenants[0],
    );
    expect(republish.status).toBe(200);
    expect(republish.headers.get('Location')).toBe(paths[0]);
    expect((await resolve()).status).toBe(200);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM app_private.restaurant_menu_link WHERE tenant_id=$1',
          [tenants[0]],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it('serves only an active approved bundle and binds its menu token to the publication', async () => {
    const menuId = crypto.randomUUID();
    const approvalInput = approvalCommand();
    await registerReviewSubject(menuId, approvalInput);
    await registerPublicBundle(menuId, approvalInput.menuRevisionId);

    expect((await requestPublicMenu(menuId)).status).toBe(404);
    const approval = MenuApprovalSchema.parse(
      await (await requestPublication(menuId, 'approvals', approvalInput)).json(),
    );
    const publication = MenuPublicationSchema.parse(
      await (
        await requestPublication(menuId, 'publications', {
          commandId: crypto.randomUUID(),
          expectedVersion: 0,
          approvalId: approval.approvalId,
        })
      ).json(),
    );

    const response = await requestPublicMenu(menuId);
    expect(response.status).toBe(200);
    expect((await requestPublicMenu(menuId, otherVenue)).status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = PublicMenuResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      schemaVersion: 1,
      venueId: venue,
      menuId,
      menuRevisionId: approvalInput.menuRevisionId,
      publicationId: publication.publicationId,
      publicationHash: publication.publicationHash,
      availabilityVersion: 1,
      tier: 'T0',
      bundle: {
        url: `https://assets.example.test/${approvalInput.menuRevisionId}.json`,
        contentHash: 'a'.repeat(64),
        assetManifestHash: 'b'.repeat(64),
      },
    });
    const verified = await jwtVerify(
      body.menuToken,
      createRemoteJWKSet(new URL('.well-known/jwks.json', `${menuTokenIssuer}/`)),
      {
        issuer: `${menuTokenIssuer}/`,
        audience: 'peekaplate-observations',
        algorithms: ['ES256'],
      },
    );
    expect(verified.payload).toMatchObject({
      venue,
      publication: publication.publicationId,
      scope: 'observations',
    });
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(1800);
    expect(verified.payload.traffic_class).toBe('test');

    // Real browser transport harness; DIN screens/outbox remain their owners' separate integration.
    const eventId = crypto.randomUUID();
    const browserServer = createServer((_, res) =>
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          '<title>Synthetic observation transport</title><button>Send synthetic visit</button><output>Waiting</output>',
        ),
    );
    await new Promise<void>((resolve) => browserServer.listen(5173, '127.0.0.1', resolve));
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('http://127.0.0.1:5173');
      const api = `http://127.0.0.1:${worker.port}`;
      const receipt = await page.evaluate(
        async ({ api, menuId, venue, eventId }) => {
          const response = await fetch(`${api}/public/venues/${venue}/menus/${menuId}`);
          if (!response.ok) throw new Error('Public menu fetch failed');
          const menu = (await response.json()) as { publicationId: string; menuToken: string };
          const event = {
            schema_version: 'observation.v2',
            event_id: eventId,
            session_id: crypto.randomUUID(),
            producer_id: crypto.randomUUID(),
            local_sequence: 1,
            occurred_at: new Date().toISOString(),
            publication_revision_id: menu.publicationId,
            type: 'menu_viewed',
            payload: { entry_source: 'qr' },
          };
          const send = async () => {
            const result = await fetch(`${api}/observations`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${menu.menuToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ contract: 'observation.v2', events: [event] }),
            });
            if (!result.ok) throw new Error(`Observation HTTP ${result.status}`);
            return result.json();
          };
          const first = await send();
          const retry = await send();
          return { first, retry };
        },
        { api, menuId, venue, eventId },
      );
      expect(ObservationReceiptBatchSchema.parse(receipt.first).receipts[0]?.status).toBe(
        'accepted',
      );
      expect(ObservationReceiptBatchSchema.parse(receipt.retry).receipts[0]?.status).toBe(
        'accepted',
      );
      await expect
        .poll(
          async () =>
            (
              await admin.query(
                'SELECT traffic_class FROM app_private.observation_event WHERE tenant_id=$1 AND event_id=$2',
                [venue, eventId],
              )
            ).rows,
          { timeout: 10000 },
        )
        .toEqual([{ traffic_class: 'test' }]);
      expect(
        (
          await admin.query(
            'SELECT * FROM app_private.observation_menu_view WHERE tenant_id=$1 AND event_id=$2',
            [venue, eventId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await admin.query(
            'SELECT * FROM app_private.owner_observation_v1 WHERE tenant_id=$1 AND event_id=$2',
            [venue, eventId],
          )
        ).rowCount,
      ).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => browserServer.close(() => resolve()));
    }

    const withdrawal = await requestPublication(menuId, 'withdrawals', {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    expect(withdrawal.status).toBe(200);
    expect((await requestPublicMenu(menuId)).status).toBe(404);
  });

  it('publishes a producer-built bundle: admit, approve, publish, public read, withdraw', async () => {
    const menuId = crypto.randomUUID();
    const dishId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const assetId = `t0_${'a'.repeat(32)}`;
    await admin.query(
      `INSERT INTO app_private.dish_current (tenant_id, dish_id, version, revision_id, name, description)
       VALUES ($1, $2, 1, $3, 'Producer dish', 'Approved producer description.')`,
      [venue, dishId, revisionId],
    );
    await admin.query(
      `INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key)
       VALUES ($1, $2, 'text', $3)`,
      [jobId, venue, `producer-${jobId}`],
    );
    await admin.query(
      `INSERT INTO app_private.dish_drafts
         (id, tenant_id, job_id, draft_id, draft_index, name, price_amount, price_currency,
          ingredients, source_id, source_text, evidence, review_status, reviewed_by, reviewed_at,
          published_dish_id)
       VALUES ($1, $2, $3, 'draft-1', 0, 'Producer dish', 18, 'USD', '["Tomato", "Basil"]'::jsonb,
               'source-1', 'Producer dish 18', '{}'::jsonb, 'accepted', $4, now(), $5)`,
      [crypto.randomUUID(), venue, jobId, actor, dishId],
    );
    const manifest = T0AssetManifestSchema.parse({
      schema_version: 1,
      asset_id: assetId,
      tier: 'T0',
      source: {
        sha256: 'b'.repeat(64),
        capture_evidence: 'Synthetic fixture; not a real restaurant capture.',
      },
      dish: { dish_id: dishId, revision_id: revisionId },
      variants: [
        ['card-480', 'webp', 480, 360],
        ['card-480', 'jpeg', 480, 360],
        ['detail-1280', 'webp', 1280, 960],
        ['detail-1280', 'jpeg', 1280, 960],
      ].map(([name, format, width, height], index) => ({
        name,
        format,
        path: `${name}.${format === 'webp' ? 'webp' : 'jpg'}`,
        sha256: String(index).repeat(64),
        size_bytes: 1000,
        width,
        height,
      })),
    });
    const bundleRequest = MenuBundleRequestSchema.parse({
      schema_version: 1,
      venue_id: venue,
      menu_id: menuId,
      restaurant: { name: 'Synthetic venue', logo: null },
      bundle_base_url: 'https://bundles.example.test/menus',
      asset_base_url: 'https://assets.example.test/t0',
      categories: [
        {
          category_id: crypto.randomUUID(),
          name: 'Mains',
          dishes: [
            {
              dish_id: dishId,
              allergens: null,
              dietary: ['vegetarian'],
              image_alt: 'Tomato and basil dish',
              t0_asset_id: assetId,
            },
          ],
        },
      ],
    });
    const produced = await produceMenuBundle(
      bundleRequest,
      await loadApprovedDishSources(admin, venue, [dishId]),
      new Map([[assetId, { manifest }]]),
    );
    expect(produced.diagnostics).toEqual([]);
    expect(produced.bundle.categories[0]?.dishes[0]?.complete).toBe(true);
    expect(
      await admitMenuBundleHandoff(admin, {
        tenantId: venue,
        menuId,
        menuRevisionId: produced.menuRevisionId,
        contentApprovalId: produced.contentApprovalId,
        contentHash: produced.contentHash,
        assetApprovalId: produced.assetApprovalId,
        assetManifestHash: produced.assetManifestHash,
        bundleUrl: produced.bundleUrl,
      }),
    ).toBe('inserted');

    const approval = MenuApprovalSchema.parse(
      await (
        await requestPublication(menuId, 'approvals', {
          commandId: crypto.randomUUID(),
          expectedVersion: 0,
          menuRevisionId: produced.menuRevisionId,
          contentApprovalId: produced.contentApprovalId,
          assetApprovalId: produced.assetApprovalId,
        })
      ).json(),
    );
    const publish = await requestPublication(menuId, 'publications', {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      approvalId: approval.approvalId,
    });
    expect(publish.status).toBe(200);

    const response = await requestPublicMenu(menuId);
    expect(response.status).toBe(200);
    const body = PublicMenuResponseSchema.parse(await response.json());
    expect(body.menuRevisionId).toBe(produced.menuRevisionId);
    expect(body.bundle).toEqual({
      url: produced.bundleUrl,
      contentHash: produced.contentHash,
      assetManifestHash: produced.assetManifestHash,
    });
    await expect(
      verifyPublicMenuContentBytes(produced.bytes, body.bundle.contentHash),
    ).resolves.toMatchObject({
      venue_id: venue,
      menu_id: menuId,
      menu_revision_id: body.menuRevisionId,
    });

    const withdrawal = await requestPublication(menuId, 'withdrawals', {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    expect(withdrawal.status).toBe(200);
    expect((await requestPublicMenu(menuId)).status).toBe(404);
  });

  it('keeps approval, publication and withdrawal as separate atomic commands', async () => {
    const menuId = crypto.randomUUID();
    const approvalInput = approvalCommand();
    await registerReviewSubject(menuId, approvalInput);
    const approvalResponse = await requestPublication(menuId, 'approvals', approvalInput);
    expect(approvalResponse.status).toBe(200);
    const approval = MenuApprovalSchema.parse(await approvalResponse.json());

    const publishCommand = {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      approvalId: approval.approvalId,
    };
    const publishedResponse = await requestPublication(menuId, 'publications', publishCommand);
    expect(publishedResponse.status).toBe(200);
    const published = MenuPublicationSchema.parse(await publishedResponse.json());
    expect(published).toMatchObject({
      menuId,
      approvalId: approval.approvalId,
      version: 1,
      availabilityVersion: 1,
      status: 'published',
    });

    const withdrawnResponse = await requestPublication(menuId, 'withdrawals', {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    expect(withdrawnResponse.status).toBe(200);
    expect(await withdrawnResponse.json()).toMatchObject({
      publicationId: published.publicationId,
      publicationHash: published.publicationHash,
      version: 2,
      availabilityVersion: 2,
      status: 'withdrawn',
    });
    expect(await publicationCounts(menuId)).toEqual({
      events: 3,
      approvals: 1,
      reviews: 1,
      publications: 1,
      receipts: 3,
      outbox: 3,
    });
  });

  it('denies non-owner approval before any publication write', async () => {
    const menuId = crypto.randomUUID();
    const approvalInput = approvalCommand();
    await registerReviewSubject(menuId, approvalInput);
    const response = await requestPublication(
      menuId,
      'approvals',
      approvalInput,
      venue,
      otherActor,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(await publicationCounts(menuId)).toEqual({
      events: 0,
      approvals: 0,
      reviews: 0,
      publications: 0,
      receipts: 0,
      outbox: 0,
    });
  });

  it('returns the original publication receipt for an identical retry', async () => {
    const menuId = crypto.randomUUID();
    const approvalInput = approvalCommand();
    await registerReviewSubject(menuId, approvalInput);
    const approval = MenuApprovalSchema.parse(
      await (await requestPublication(menuId, 'approvals', approvalInput)).json(),
    );
    const publishCommand = {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      approvalId: approval.approvalId,
    };
    const first = await requestPublication(menuId, 'publications', publishCommand);
    const retry = await requestPublication(menuId, 'publications', publishCommand);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(await publicationCounts(menuId)).toEqual({
      events: 2,
      approvals: 1,
      reviews: 1,
      publications: 1,
      receipts: 2,
      outbox: 2,
    });
  });

  it('allows only one of two concurrent first publications to commit', async () => {
    const menuId = crypto.randomUUID();
    const firstInput = approvalCommand();
    const secondInput = approvalCommand(1);
    await registerReviewSubject(menuId, firstInput);
    await registerReviewSubject(menuId, secondInput);
    const firstApproval = MenuApprovalSchema.parse(
      await (await requestPublication(menuId, 'approvals', firstInput)).json(),
    );
    const secondApproval = MenuApprovalSchema.parse(
      await (await requestPublication(menuId, 'approvals', secondInput)).json(),
    );
    const responses = await Promise.all([
      requestPublication(menuId, 'publications', {
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        approvalId: firstApproval.approvalId,
      }),
      requestPublication(menuId, 'publications', {
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        approvalId: secondApproval.approvalId,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await publicationCounts(menuId)).toEqual({
      events: 3,
      approvals: 2,
      reviews: 1,
      publications: 1,
      receipts: 3,
      outbox: 3,
    });

    const events = await admin.query(
      `SELECT tenant_id AS "tenantId", stream_type AS "streamType",
        stream_id AS "streamId", version, schema_version AS "schemaVersion",
        event_type AS "eventType", payload, metadata
       FROM app_private.es_event
       WHERE tenant_id=$1 AND stream_type='menu_publication' AND stream_id=$2
       ORDER BY version`,
      [venue, menuId],
    );
    const current = await admin.query(
      `SELECT tenant_id AS "tenantId", menu_id AS "menuId",
        publication_id AS "publicationId", version, approval_id AS "approvalId",
        publication_hash AS "publicationHash",
        availability_version AS "availabilityVersion", status
       FROM app_private.menu_publication_current
       WHERE tenant_id=$1 AND menu_id=$2`,
      [venue, menuId],
    );
    expect(replayPublication(events.rows)).toEqual(current.rows[0]);

    const reviewEvents = await admin.query(
      `SELECT tenant_id AS "tenantId", stream_type AS "streamType",
        stream_id AS "streamId", version, schema_version AS "schemaVersion",
        event_type AS "eventType", payload, metadata
       FROM app_private.es_event
       WHERE tenant_id=$1 AND stream_type='menu_review' AND stream_id=$2
       ORDER BY version`,
      [venue, menuId],
    );
    const reviewCurrent = await admin.query(
      `SELECT current.tenant_id AS "tenantId", current.menu_id AS "menuId",
        approval.approval_id AS "approvalId", current.version,
        approval.menu_revision_id AS "menuRevisionId",
        approval.content_approval_id AS "contentApprovalId",
        approval.content_hash AS "contentHash",
        approval.asset_approval_id AS "assetApprovalId",
        approval.asset_manifest_hash AS "assetManifestHash",
        'approved' AS status
       FROM app_private.menu_review_current current
       JOIN app_private.menu_approval approval
         ON approval.tenant_id=current.tenant_id
        AND approval.menu_id=current.menu_id
        AND approval.approval_id=current.approval_id
       WHERE current.tenant_id=$1 AND current.menu_id=$2`,
      [venue, menuId],
    );
    expect(replayReview(reviewEvents.rows)).toEqual(reviewCurrent.rows[0]);
  });

  it('rejects an owner-supplied revision that has no canonical review subject', async () => {
    const menuId = crypto.randomUUID();
    const response = await requestPublication(menuId, 'approvals', approvalCommand());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'review_subject_not_found' });
    expect(await publicationCounts(menuId)).toEqual({
      events: 0,
      approvals: 0,
      reviews: 0,
      publications: 0,
      receipts: 0,
      outbox: 0,
    });
  });
});

describe('real PostgreSQL owner insight actions', () => {
  function createInput(menuId: string, menuRevisionId: string) {
    return {
      commandId: crypto.randomUUID(),
      insightKey: `insight-${crypto.randomUUID()}`,
      menuId,
      menuRevisionId,
      category: 'description_update',
      note: 'Update the menu description',
    };
  }

  async function createAction(body: unknown, tenant = venue, subject = actor) {
    return fetch(`http://127.0.0.1:${worker.port}/venues/${tenant}/owner-insight-actions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await token({ sub: subject })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function listActions(tenant = venue, subject = actor) {
    return fetch(`http://127.0.0.1:${worker.port}/venues/${tenant}/owner-insight-actions`, {
      headers: { Authorization: `Bearer ${await token({ sub: subject })}` },
    });
  }

  async function updateAction(actionId: string, body: unknown, tenant = venue, subject = actor) {
    return fetch(
      `http://127.0.0.1:${worker.port}/venues/${tenant}/owner-insight-actions/${actionId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${await token({ sub: subject })}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
  }

  it('persists create, update and list results against the canonical menu revision', async () => {
    const menuId = crypto.randomUUID();
    const revision = approvalCommand();
    await registerReviewSubject(menuId, revision);

    const input = createInput(menuId, revision.menuRevisionId);
    const created = await createAction(input);

    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      schemaVersion: number;
      action: { actionId: string; status: string; version: number };
    };
    expect(createdBody).toMatchObject({
      schemaVersion: 1,
      action: {
        status: 'planned',
        version: 1,
      },
    });

    const actionId = createdBody.action.actionId;
    const updated = await updateAction(actionId, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      status: 'active',
    });

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      schemaVersion: 1,
      action: {
        actionId,
        status: 'active',
        version: 2,
      },
    });

    const listed = await listActions();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      schemaVersion: 1,
      actions: [
        {
          actionId,
          menuId,
          menuRevisionId: revision.menuRevisionId,
          status: 'active',
          version: 2,
        },
      ],
    });

    const persisted = await admin.query(
      `SELECT category, status, note, version, created_by, updated_by
       FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1 AND action_id = $2`,
      [venue, actionId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      category: 'description_update',
      status: 'active',
      note: input.note,
      version: 2,
      created_by: actor,
      updated_by: actor,
    });
  });

  it('coalesces concurrent identical creates and replays the committed receipt', async () => {
    const menuId = crypto.randomUUID();
    const revision = approvalCommand();
    await registerReviewSubject(menuId, revision);

    const input = createInput(menuId, revision.menuRevisionId);
    const responses = await Promise.all([createAction(input), createAction(input)]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);

    const results = await Promise.all(
      responses.map(
        async (response) => (await response.json()) as { action: { actionId: string } },
      ),
    );
    expect(results[0]).toEqual(results[1]);

    expect(results).toHaveLength(2);
    const firstResult = results[0];
    if (!firstResult) throw new Error('Missing first concurrent create result');
    const actionId = firstResult.action.actionId;
    const retry = await createAction(input);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(results[0]);

    const actions = await admin.query(
      `SELECT action_id
       FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1 AND menu_id = $2`,
      [venue, menuId],
    );
    expect(actions.rows).toEqual([{ action_id: actionId }]);

    const receipts = await admin.query(
      `SELECT idempotency_key
       FROM app_private.es_command
       WHERE tenant_id = $1 AND actor_id = $2
         AND idempotency_key = $3
         AND command_type = 'owner.insight_action.create'`,
      [venue, actor, input.commandId],
    );
    expect(receipts.rows).toHaveLength(1);
  });

  it('rejects competing updates and replays an earlier receipt without reverting later state', async () => {
    const menuId = crypto.randomUUID();
    const revision = approvalCommand();
    await registerReviewSubject(menuId, revision);
    const created = await createAction(createInput(menuId, revision.menuRevisionId));
    expect(created.status).toBe(201);
    const { action: createdAction } = (await created.json()) as {
      action: { actionId: string };
    };
    const updates = ['First change', 'Second change'].map((note) => ({
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      status: 'active',
      note,
    }));
    const responses = await Promise.all(
      updates.map((input) => updateAction(createdAction.actionId, input)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winnerIndex = responses.findIndex((response) => response.status === 200);
    const winnerInput = updates[winnerIndex]!;
    const winnerResult = await responses[winnerIndex]!.json();
    expect(winnerResult).toMatchObject({ action: { version: 2, note: winnerInput.note } });
    expect(await responses.find((response) => response.status === 409)!.json()).toEqual({
      error: 'version_conflict',
    });

    const later = await updateAction(createdAction.actionId, {
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      status: 'archived',
    });
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({ action: { version: 3, status: 'archived' } });
    const retry = await updateAction(createdAction.actionId, winnerInput);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(winnerResult);

    const reused = await updateAction(createdAction.actionId, {
      ...winnerInput,
      note: 'Different command payload',
    });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: 'command_conflict' });
    const persisted = await admin.query(
      `SELECT status, version FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1 AND action_id = $2`,
      [venue, createdAction.actionId],
    );
    expect(persisted.rows).toEqual([{ status: 'archived', version: 3 }]);
  });

  it('keeps list and update tenant-scoped even when an actor owns both venues', async () => {
    const dualOwner = crypto.randomUUID();
    await admin.query(
      `INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission)
       VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`,
      [venue, otherVenue, dualOwner],
    );
    const menuId = crypto.randomUUID();
    const revision = approvalCommand();
    await registerReviewSubject(menuId, revision);
    const created = await createAction(createInput(menuId, revision.menuRevisionId));
    expect(created.status).toBe(201);
    const { action: createdAction } = (await created.json()) as {
      action: { actionId: string };
    };
    const listed = await listActions(otherVenue, dualOwner);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ schemaVersion: 1, actions: [] });
    const denied = await updateAction(
      createdAction.actionId,
      { commandId: crypto.randomUUID(), expectedVersion: 1, status: 'archived' },
      otherVenue,
      dualOwner,
    );
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: 'not_found' });
    const persisted = await admin.query(
      `SELECT status, version FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1 AND action_id = $2`,
      [venue, createdAction.actionId],
    );
    expect(persisted.rows).toEqual([{ status: 'planned', version: 1 }]);
  });

  it('rejects editor, viewer and cross-venue access without creating actions', async () => {
    const menuId = crypto.randomUUID();
    const revision = approvalCommand();
    await registerReviewSubject(menuId, revision);

    const input = createInput(menuId, revision.menuRevisionId);

    expect((await createAction(input, venue, otherActor)).status).toBe(403);
    expect((await createAction(input, venue, viewer)).status).toBe(403);
    expect((await createAction(input, otherVenue, actor)).status).toBe(403);

    const listedAsEditor = await listActions(venue, otherActor);
    expect(listedAsEditor.status).toBe(403);

    const actions = await admin.query(
      `SELECT action_id
       FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1 AND menu_id = $2`,
      [venue, menuId],
    );
    expect(actions.rows).toHaveLength(0);
  });

  it('reauthorizes a revoked owner before replaying an existing receipt', async () => {
    const revokedActor = crypto.randomUUID();
    const menuId = crypto.randomUUID();
    const revision = approvalCommand();

    await admin.query(
      `INSERT INTO app_private.staff_membership
        (tenant_id, actor_id, permission)
       VALUES ($1, $2, 'owner')`,
      [venue, revokedActor],
    );
    await registerReviewSubject(menuId, revision);

    const input = createInput(menuId, revision.menuRevisionId);
    const first = await createAction(input, venue, revokedActor);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { action: { actionId: string } };

    await admin.query(
      `DELETE FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2`,
      [venue, revokedActor],
    );

    const retry = await createAction(input, venue, revokedActor);
    expect(retry.status).toBe(403);
    expect(await retry.json()).toEqual({ error: 'forbidden' });

    const persisted = await admin.query(
      `SELECT action_id
       FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1 AND menu_id = $2`,
      [venue, menuId],
    );
    expect(persisted.rows).toEqual([{ action_id: firstBody.action.actionId }]);
  });

  it('rejects a menu revision that is not registered for the route venue', async () => {
    const input = createInput(crypto.randomUUID(), crypto.randomUUID());
    const response = await createAction(input);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'menu_revision_not_found',
    });

    const receipts = await admin.query(
      `SELECT idempotency_key
       FROM app_private.es_command
       WHERE tenant_id = $1 AND actor_id = $2
         AND idempotency_key = $3`,
      [venue, actor, input.commandId],
    );
    expect(receipts.rows).toHaveLength(0);
  });
});

describe('Multi-tenant owner report isolation', () => {
  it('isolates reports and counts distinct reportable sessions', async () => {
    const dishId = crypto.randomUUID();
    const dishResponse = await request(dishId);
    expect(dishResponse.status).toBe(200);
    const dish = (await dishResponse.json()) as { revisionId: string };
    const publicationId = crypto.randomUUID();
    const producerId = crypto.randomUUID();
    let sequence = 0;

    const insertEvent = async (
      eventType: string,
      sessionId: string,
      occurredAt = new Date(),
      trafficClass: 'live' | 'test' = 'live',
    ) => {
      const eventId = crypto.randomUUID();
      await admin.query(
        `INSERT INTO app_private.observation_index
          (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type,
           authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition)
         VALUES ($1, $2, $3, 'observation.v2', $4, $5, $6, $6, $7, 'accepted')`,
        [venue, eventId, 'a'.repeat(64), eventType, publicationId, occurredAt, `test/${eventId}`],
      );
      await admin.query(
        `INSERT INTO app_private.observation_event
          (tenant_id, event_id, event_type, session_id, producer_id, local_sequence,
           publication_revision_id, traffic_class)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [venue, eventId, eventType, sessionId, producerId, ++sequence, publicationId, trafficClass],
      );
      return eventId;
    };

    const addExposure = async (
      sessionId: string,
      targetDishId = dishId,
      targetRevisionId = dish.revisionId,
      trafficClass: 'live' | 'test' = 'live',
      occurredAt = new Date(),
    ) => {
      const eventId = await insertEvent('dish_viewed', sessionId, occurredAt, trafficClass);
      const exposureId = crypto.randomUUID();
      await admin.query(
        `INSERT INTO app_private.observation_exposure
          (tenant_id, event_id, dish_id, dish_revision_id, exposure_id, surface, position, exposure_basis)
         VALUES ($1, $2, $3, $4, $5, 'menu_list', 1, 'viewport_50pct_1s')`,
        [venue, eventId, targetDishId, targetRevisionId, exposureId],
      );
      return exposureId;
    };

    const addOpening = async (
      sessionId: string,
      source: 'menu_card' | 'direct',
      fromExposureId: string | null,
      activeMs?: number,
      activityOccurredAt?: Date,
      openingOccurredAt?: Date,
      targetDishId = dishId,
      targetRevisionId = dish.revisionId,
      trafficClass: 'live' | 'test' = 'live',
    ) => {
      const openingId = crypto.randomUUID();
      const eventId = await insertEvent(
        'dish_detail_opened',
        sessionId,
        openingOccurredAt,
        trafficClass,
      );
      await admin.query(
        `INSERT INTO app_private.observation_opening
          (tenant_id, event_id, dish_id, dish_revision_id, opening_id, source, from_exposure_id, save_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [venue, eventId, targetDishId, targetRevisionId, openingId, source, fromExposureId],
      );
      if (activeMs === undefined) return;
      const checkpointId = await insertEvent(
        'dish_activity_checkpoint',
        sessionId,
        activityOccurredAt,
        trafficClass,
      );
      await admin.query(
        `INSERT INTO app_private.observation_activity
          (tenant_id, event_id, dish_id, dish_revision_id, opening_id, active_ms, final)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [venue, checkpointId, targetDishId, targetRevisionId, openingId, activeMs],
      );
    };

    const addComparison = async (
      sessionId: string,
      comparedDishId = dishId,
      comparedRevisionId = dish.revisionId,
      otherDishId = crypto.randomUUID(),
      otherRevisionId = crypto.randomUUID(),
      occurredAt = new Date(),
      comparisonId = crypto.randomUUID(),
    ) => {
      const eventId = await insertEvent('dish_compared', sessionId, occurredAt);
      await admin.query(
        `INSERT INTO app_private.observation_comparison
          (tenant_id, event_id, dish_id, dish_revision_id, other_dish_id,
           other_dish_revision_id, comparison_id, compare_action, save_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'start', true)`,
        [
          venue,
          eventId,
          comparedDishId,
          comparedRevisionId,
          otherDishId,
          otherRevisionId,
          comparisonId,
        ],
      );
    };

    const addDirectSave = async (
      sessionId: string,
      targetDishId = dishId,
      targetRevisionId = dish.revisionId,
      trafficClass: 'live' | 'test' = 'live',
    ) => {
      const eventId = await insertEvent('dish_saved', sessionId, new Date(), trafficClass);
      await admin.query(
        `INSERT INTO app_private.observation_save
          (tenant_id, event_id, event_type, dish_id, dish_revision_id, save_origin, surface, shortlist_size)
         VALUES ($1, $2, 'dish_saved', $3, $4, 'direct', 'menu_card', 1)`,
        [venue, eventId, targetDishId, targetRevisionId],
      );
    };

    const exposedSessions = Array.from({ length: 12 }, () => crypto.randomUUID());
    const exposures = new Map<string, string>();
    for (const sessionId of exposedSessions) {
      exposures.set(sessionId, await addExposure(sessionId));
    }
    await addExposure(exposedSessions[0]!);

    for (const [index, sessionId] of exposedSessions.slice(0, 10).entries()) {
      await addOpening(
        sessionId,
        'menu_card',
        exposures.get(sessionId)!,
        index < 3 ? 10_000 : 5_000,
      );
    }
    await addOpening(exposedSessions[0]!, 'menu_card', exposures.get(exposedSessions[0]!)!);

    const directSessions = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const sessionId of directSessions) await addOpening(sessionId, 'direct', null);
    await addOpening(
      directSessions[2]!,
      'direct',
      null,
      100_000,
      new Date(Date.now() - 25 * 60 * 60 * 1000),
    );
    await addOpening(
      exposedSessions[10]!,
      'menu_card',
      exposures.get(exposedSessions[10]!)!,
      undefined,
      undefined,
      new Date(Date.now() + 2 * 60 * 1000),
    );

    await addComparison(directSessions[0]!);
    await addComparison(directSessions[0]!);
    await addComparison(directSessions[1]!);
    await addComparison(crypto.randomUUID());
    await addComparison(exposedSessions[3]!);
    await addDirectSave(exposedSessions[0]!);
    await addDirectSave(exposedSessions[0]!);
    await addDirectSave(directSessions[0]!);
    await addDirectSave(exposedSessions[10]!);

    const requestReport = async (tenant: string, subject: string) =>
      fetch(
        `http://127.0.0.1:${worker.port}/api/v1/venues/${tenant}/analytics/dishes?source=synthetic`,
        {
          headers: { Authorization: `Bearer ${await token({ sub: subject })}` },
        },
      );

    const ownerResponse = await requestReport(venue, actor);
    expect(ownerResponse.status).toBe(200);
    const ownerReport = OwnerDishReportSchema.parse(await ownerResponse.json());
    expect(ownerReport.venue_id).toBe(venue);
    expect(ownerReport).toMatchObject({
      source: 'synthetic',
      report_metadata: { calculation_version: 'synthetic.v1' },
    });
    expect(ownerReport.dishes).toHaveLength(1);
    expect(ownerReport.dishes[0]?.metrics).toMatchObject({
      active_sessions: { value: 12, status: 'NORMAL' },
      open_rate: { value: 0.833, status: 'NORMAL' },
      engagement_rate: { value: 0.429, status: 'NORMAL' },
      save_rate: { value: 0.167, status: 'NORMAL' },
      avg_interaction_time_seconds: { value: 6.5, status: 'NORMAL' },
      timing_coverage: { value: 0.625, status: 'NORMAL' },
    });
    expect(JSON.stringify(ownerReport)).not.toContain('eligible_sessions');

    const liveDishMetrics = structuredClone(ownerReport.dishes[0]?.metrics);
    const firstPairDishId = crypto.randomUUID();
    const firstPairDishResponse = await request(
      firstPairDishId,
      command({ name: 'Comparison soup' }),
    );
    expect(firstPairDishResponse.status).toBe(200);
    const firstPairDish = (await firstPairDishResponse.json()) as { revisionId: string };
    const secondPairDishId = crypto.randomUUID();
    const secondPairDishResponse = await request(
      secondPairDishId,
      command({ name: 'Comparison salad' }),
    );
    expect(secondPairDishResponse.status).toBe(200);
    const secondPairDish = (await secondPairDishResponse.json()) as { revisionId: string };
    const pairStart = Date.now() - 2 * 60_000;

    for (let index = 0; index < 11; index++) {
      const sessionId = crypto.randomUUID();
      const sessionStart = new Date(pairStart + index * 1_000);
      const firstExposure = await addExposure(
        sessionId,
        firstPairDishId,
        firstPairDish.revisionId,
        'live',
        sessionStart,
      );
      const secondExposure = await addExposure(
        sessionId,
        secondPairDishId,
        secondPairDish.revisionId,
        'live',
        sessionStart,
      );
      const comparisonId = crypto.randomUUID();

      if (index < 10) {
        const openingAt = new Date(sessionStart.getTime() + 100);
        await addOpening(
          sessionId,
          'menu_card',
          firstExposure,
          undefined,
          undefined,
          openingAt,
          firstPairDishId,
          firstPairDish.revisionId,
        );
        await addComparison(
          sessionId,
          firstPairDishId,
          firstPairDish.revisionId,
          secondPairDishId,
          secondPairDish.revisionId,
          index === 0 ? openingAt : new Date(sessionStart.getTime() + 200),
          comparisonId,
        );
        if (index === 0) {
          await addComparison(
            sessionId,
            firstPairDishId,
            firstPairDish.revisionId,
            secondPairDishId,
            secondPairDish.revisionId,
            new Date(sessionStart.getTime() + 250),
            comparisonId,
          );
        }
        await addOpening(
          sessionId,
          'menu_card',
          secondExposure,
          undefined,
          undefined,
          new Date(sessionStart.getTime() + 300),
          secondPairDishId,
          secondPairDish.revisionId,
        );
      } else {
        await addComparison(
          sessionId,
          firstPairDishId,
          firstPairDish.revisionId,
          secondPairDishId,
          secondPairDish.revisionId,
          new Date(sessionStart.getTime() + 100),
          comparisonId,
        );
        await addOpening(
          sessionId,
          'menu_card',
          firstExposure,
          undefined,
          undefined,
          new Date(sessionStart.getTime() + 100),
          firstPairDishId,
          firstPairDish.revisionId,
        );
        await addOpening(
          sessionId,
          'menu_card',
          secondExposure,
          undefined,
          undefined,
          new Date(sessionStart.getTime() + 300),
          secondPairDishId,
          secondPairDish.revisionId,
        );
      }
    }

    const pairReport = OwnerDishReportSchema.parse(
      await (await requestReport(venue, actor)).json(),
    );
    for (const pairDishId of [firstPairDishId, secondPairDishId]) {
      const pairDishReport = pairReport.dishes.find((item) => item.dish_id === pairDishId);
      expect(pairDishReport?.metrics.engagement_rate).toEqual({
        value: 0.909,
        status: 'NORMAL',
      });
    }

    const timingDishId = crypto.randomUUID();
    const timingDishResponse = await request(timingDishId, command({ name: 'Timing cohort dish' }));
    expect(timingDishResponse.status).toBe(200);
    const timingDish = (await timingDishResponse.json()) as { revisionId: string };
    const timingStart = Date.now() - 60_000;
    for (let index = 0; index < 10; index++) {
      const sessionId = crypto.randomUUID();
      const sessionStart = new Date(timingStart + index * 1_000);
      const exposureId = await addExposure(
        sessionId,
        timingDishId,
        timingDish.revisionId,
        'live',
        sessionStart,
      );
      await addOpening(
        sessionId,
        'menu_card',
        exposureId,
        index < 9 ? 5_000 : undefined,
        new Date(sessionStart.getTime() + 200),
        new Date(sessionStart.getTime() + 100),
        timingDishId,
        timingDish.revisionId,
      );
    }
    const timingReport = OwnerDishReportSchema.parse(
      await (await requestReport(venue, actor)).json(),
    );
    const timingDishReport = timingReport.dishes.find((item) => item.dish_id === timingDishId);
    expect(timingDishReport?.metrics).toMatchObject({
      active_sessions: { value: null, status: 'SUPPRESSED' },
      avg_interaction_time_seconds: { value: null, status: 'SUPPRESSED' },
      timing_coverage: { value: null, status: 'SUPPRESSED' },
      open_rate: { value: null, status: 'SUPPRESSED' },
      engagement_rate: { value: 0, status: 'VALID_ZERO' },
      save_rate: { value: 0, status: 'VALID_ZERO' },
    });

    const openingCoverageDishId = crypto.randomUUID();
    const openingCoverageDishResponse = await request(
      openingCoverageDishId,
      command({ name: 'Opening coverage dish' }),
    );
    expect(openingCoverageDishResponse.status).toBe(200);
    const openingCoverageDish = (await openingCoverageDishResponse.json()) as {
      revisionId: string;
    };
    const openingCoverageSessions: Array<{ sessionId: string; exposureId: string }> = [];
    for (let index = 0; index < 10; index++) {
      const sessionId = crypto.randomUUID();
      const exposureId = await addExposure(
        sessionId,
        openingCoverageDishId,
        openingCoverageDish.revisionId,
      );
      openingCoverageSessions.push({ sessionId, exposureId });
      await addOpening(
        sessionId,
        'menu_card',
        exposureId,
        5_000,
        undefined,
        undefined,
        openingCoverageDishId,
        openingCoverageDish.revisionId,
      );
      await addOpening(
        sessionId,
        'menu_card',
        exposureId,
        undefined,
        undefined,
        undefined,
        openingCoverageDishId,
        openingCoverageDish.revisionId,
      );
    }
    const openingCoverageReport = OwnerDishReportSchema.parse(
      await (await requestReport(venue, actor)).json(),
    );
    expect(
      openingCoverageReport.dishes.find((item) => item.dish_id === openingCoverageDishId)?.metrics
        .timing_coverage,
    ).toEqual({ value: 0.5, status: 'NORMAL' });

    const repeatedOpening = openingCoverageSessions[0]!;
    await addOpening(
      repeatedOpening.sessionId,
      'menu_card',
      repeatedOpening.exposureId,
      undefined,
      undefined,
      undefined,
      openingCoverageDishId,
      openingCoverageDish.revisionId,
    );
    const repeatedOpeningReport = OwnerDishReportSchema.parse(
      await (await requestReport(venue, actor)).json(),
    );
    expect(
      repeatedOpeningReport.dishes.find((item) => item.dish_id === openingCoverageDishId)?.metrics
        .timing_coverage,
    ).toEqual({ value: 0.476, status: 'NORMAL' });

    const testOnlySessions = Array.from({ length: 12 }, () => crypto.randomUUID());
    for (const sessionId of testOnlySessions) {
      const exposureId = await addExposure(sessionId, dishId, dish.revisionId, 'test');
      await addOpening(
        sessionId,
        'menu_card',
        exposureId,
        20_000,
        undefined,
        undefined,
        dishId,
        dish.revisionId,
        'test',
      );
      await addDirectSave(sessionId, dishId, dish.revisionId, 'test');
    }
    const afterTestTraffic = OwnerDishReportSchema.parse(
      await (await requestReport(venue, actor)).json(),
    );
    expect(afterTestTraffic.dishes.find((item) => item.dish_id === dishId)?.metrics).toEqual(
      liveDishMetrics,
    );
    expect(JSON.stringify(afterTestTraffic)).not.toContain('test');

    const cohortCases: Array<{ sessions: number; dishId: string; revisionId: string }> = [];
    for (const sessions of [9, 10, 11]) {
      const cohortDishId = crypto.randomUUID();
      const created = await request(cohortDishId, command({ name: `Cohort ${sessions} dish` }));
      expect(created.status).toBe(200);
      const createdDish = (await created.json()) as { revisionId: string };
      cohortCases.push({
        sessions,
        dishId: cohortDishId,
        revisionId: createdDish.revisionId,
      });
      for (let index = 0; index < sessions; index++) {
        const sessionId = crypto.randomUUID();
        const exposureId = await addExposure(sessionId, cohortDishId, createdDish.revisionId);
        await addOpening(
          sessionId,
          'menu_card',
          exposureId,
          5_000,
          undefined,
          undefined,
          cohortDishId,
          createdDish.revisionId,
        );
      }
    }
    const boundaryReport = OwnerDishReportSchema.parse(
      await (await requestReport(venue, actor)).json(),
    );
    for (const cohortCase of cohortCases) {
      const row = boundaryReport.dishes.find((item) => item.dish_id === cohortCase.dishId);
      expect(row).toBeDefined();
      if (cohortCase.sessions === 9) {
        expect(row?.evidence_state).toBe('SUPPRESSED');
        for (const metric of Object.values(row?.metrics ?? {})) {
          expect(metric.value).toBeNull();
        }
      } else {
        expect(row?.metrics.active_sessions).toEqual({
          value: cohortCase.sessions,
          status: 'NORMAL',
        });
        expect(row?.metrics.open_rate).toEqual({ value: 1, status: 'NORMAL' });
      }
    }

    const editorResponse = await requestReport(venue, otherActor);
    expect(editorResponse.status).toBe(403);

    const otherTenantResponse = await requestReport(venue, otherVenueOwner);
    expect(otherTenantResponse.status).toBe(403);

    const otherOwnerResponse = await requestReport(otherVenue, otherVenueOwner);
    expect(otherOwnerResponse.status).toBe(503);
    expect(await otherOwnerResponse.json()).toEqual({ error: 'service_unavailable' });

    const revokedActor = crypto.randomUUID();
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id, actor_id, permission)
       VALUES ($1, $2, 'owner')`,
      [venue, revokedActor],
    );
    expect((await requestReport(venue, revokedActor)).status).toBe(200);
    await admin.query(
      'DELETE FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2',
      [venue, revokedActor],
    );
    const revokedResponse = await requestReport(venue, revokedActor);
    expect(revokedResponse.status).toBe(403);
    expect(await revokedResponse.json()).toEqual({ error: 'forbidden' });
  });
});

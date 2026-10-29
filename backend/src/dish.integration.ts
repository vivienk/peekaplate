import { createServer, type Server } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import { DishRevisionSchema } from '@peekaplate/contracts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev } from 'wrangler';
import { createDishRevision, replayDish } from './dish-command';
import type { Bindings } from './index';
import { readTeamAnalytics } from './team-analytics';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
if (!runtimeUrl || !adminUrl)
  throw new Error('Run pnpm verify test:db with its disposable database');
const admin = new Client({ connectionString: adminUrl });
const venue = crypto.randomUUID();
const otherVenue = crypto.randomUUID();
const actor = crypto.randomUUID();
const otherActor = crypto.randomUUID();
const viewer = crypto.randomUUID();
let server: Server;
let env: Bindings;
let signingKey: CryptoKey;
let collaboratorEnabled = true;
const githubCalls: string[] = [];
let worker: Awaited<ReturnType<typeof unstable_dev>>;

function command(patch = {}) {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion: 0,
    name: 'Test dish',
    description: 'Synthetic fixture',
    ...patch,
  };
}

async function token(subject: string) {
  return new SignJWT({ role: 'authenticated', is_anonymous: false })
    .setProtectedHeader({ alg: 'ES256', kid: 'integration' })
    .setIssuer(env.AUTH_ISSUER!)
    .setAudience('authenticated')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

async function request(dishId: string, body = command(), tenant = venue, subject = actor) {
  return fetch(`http://127.0.0.1:${worker.port}/venues/${tenant}/dishes/${dishId}/revisions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token(subject)}`,
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
      Authorization: `Bearer ${await token(subject)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
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
    VALUES ($1,$3,'owner'),($1,$4,'editor'),($1,$5,'viewer'),($2,$4,'owner')`,
    [venue, otherVenue, actor, otherActor, viewer],
  );
  const keys = await generateKeyPair('ES256');
  signingKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'integration', alg: 'ES256' };
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
    if (req.url !== '/auth/v1/.well-known/jwks.json') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local JWKS listener');
  env = {
    APP_ENV: 'local',
    AUTH_ISSUER: `http://127.0.0.1:${address.port}/auth/v1`,
    LOCAL_DATABASE_URL: runtimeUrl,
  };
  worker = await unstable_dev(fileURLToPath(new URL('./index.ts', import.meta.url)), {
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    local: true,
    ip: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    logLevel: 'error',
    vars: {
      APP_ENV: 'local',
      AUTH_ISSUER: env.AUTH_ISSUER!,
      LOCAL_DATABASE_URL: runtimeUrl!,
      POSTHOG_PROJECT_ID: '675372',
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
  await admin.end();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
});

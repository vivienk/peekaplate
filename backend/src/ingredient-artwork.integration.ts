import { createHash } from 'node:crypto';
import {
  type ArtworkCommand,
  ArtworkStateSchema,
  PublicArtworkSchema,
} from '@peekaplate/contracts';
import { Hono } from 'hono';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from './auth';
import type { Bindings } from './index';
import { readArtwork, replayArtwork, reviewArtwork } from './ingredient-artwork';
import { registerArtworkRoutes } from './ingredient-artwork-routes';
import { authorizeStaffVenue } from './staff-venue';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
describe.skipIf(!runtimeUrl || !adminUrl)('Hosted ingredient artwork database', () => {
  const admin = new Client({ connectionString: adminUrl });
  const db = new Client({ connectionString: runtimeUrl });
  const venue = crypto.randomUUID(),
    other = crypto.randomUUID(),
    actor = crypto.randomUUID(),
    viewer = crypto.randomUUID();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJElEQVR4nO3MMQEAAAgDoEU0ju01hIcPBCABADiarrkeAEA+LbVgAsefyYE+AAAAAElFTkSuQmCC',
    'base64',
  );
  const input = (label = 'grilled chicken'): ArtworkCommand => ({
    commandId: crypto.randomUUID(),
    label,
    expectedVersion: 0,
    status: 'approved',
    sha256: createHash('sha256').update(png).digest('hex'),
    pngBase64: png.toString('base64'),
    reason: 'Synthetic test approval',
    sourceAssetId: 'a'.repeat(64),
    rightsConfirmed: true,
    styleVersion: 'figma-149-2169.v1',
    recipe: 'Synthetic fixture',
  });
  const objects = new Map<string, ArrayBuffer>();
  const storage = {
    put: vi.fn(async (key: string, bytes: ArrayBuffer) => {
      objects.set(key, bytes);
    }),
    get: async (key: string) => {
      const data = objects.get(key);
      return data ? { size: data.byteLength, arrayBuffer: async () => data } : null;
    },
  };
  const env: Bindings = {
    INGREDIENT_ARTWORK_ENABLED: 'true',
    INGESTION_REPORTS_BUCKET: storage as never,
  };
  const app = new Hono<{ Bindings: Bindings }>();
  registerArtworkRoutes(app, {
    verify: async (header) => {
      if (header !== 'Bearer test') throw new AuthenticationError();
      return actor;
    },
    authorizeVenue: async (a, v) => authorizeStaffVenue(db, a, v),
    database: async (_env, work) => work(db),
  });
  app.onError((error, c) =>
    c.json({ error: 'rejected' }, 'status' in error ? (error.status as never) : 500),
  );
  beforeAll(async () => {
    await admin.connect();
    await db.connect();
    await admin.query(
      "INSERT INTO app_private.venues(id,name) VALUES($1,'Synthetic art'),($2,'Other art')",
      [venue, other],
    );
    await admin.query(
      "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner'),($1,$3,'viewer')",
      [venue, actor, viewer],
    );
  });
  afterAll(async () => {
    await db.end();
    await admin.end();
  });
  it('approval API makes exact bytes available immediately; revocation withdraws both catalogue and old URL', async () => {
    const command = input();
    const publicUrl = `/public/venues/${venue}/ingredient-icons?label=grilled+chicken`;
    expect(
      PublicArtworkSchema.parse(await (await app.request(publicUrl, {}, env)).json()).icons,
    ).toEqual([]);
    const approved = await app.request(
      `/venues/${venue}/ingredient-icons/review`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      },
      env,
    );
    expect(approved.status).toBe(200);
    const state = ArtworkStateSchema.parse(((await approved.json()) as { state: unknown }).state);
    const catalogue = await app.request(publicUrl, {}, env);
    expect(catalogue.headers.get('Cache-Control')).toBe('no-store');
    expect(PublicArtworkSchema.parse(await catalogue.json()).icons).toEqual([state]);
    const imageUrl = `/public/venues/${venue}/ingredient-icons/image?label=grilled+chicken&sha256=${state.sha256}`;
    const image = await app.request(imageUrl, {}, env);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    const puts = storage.put.mock.calls.length;
    expect(await reviewArtwork(db, actor, venue, command, storage)).toEqual(state);
    expect(storage.put.mock.calls.length).toBe(puts);
    await expect(
      reviewArtwork(db, actor, venue, { ...command, reason: 'changed' }, storage),
    ).rejects.toMatchObject({ code: 'command_conflict' });
    await reviewArtwork(
      db,
      actor,
      venue,
      {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        label: 'grilled chicken',
        status: 'revoked',
        reason: 'Withdraw style',
      },
      storage,
    );
    expect(
      PublicArtworkSchema.parse(await (await app.request(publicUrl, {}, env)).json()).icons,
    ).toEqual([]);
    expect((await app.request(imageUrl, {}, env)).status).toBe(404);
    // An old approval retry returns its receipt but never restores the revoked pointer.
    expect(await reviewArtwork(db, actor, venue, command, storage)).toEqual(state);
    expect((await app.request(imageUrl, {}, env)).status).toBe(404);
    const events = await admin.query(
      "SELECT tenant_id,stream_id,version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_type='ingredient_artwork' ORDER BY version",
      [venue],
    );
    expect(replayArtwork(events.rows)).toEqual(
      (await readArtwork(db, venue, ['grilled chicken']))[0],
    );
  });
  it('unauthorized, cross-venue and viewer writes fail; reads remain tenant-scoped', async () => {
    const command = input('coconut');
    expect(
      (await app.request(`/venues/${venue}/ingredient-icons/review`, { method: 'POST' }, env))
        .status,
    ).toBe(401);
    await expect(reviewArtwork(db, viewer, venue, command, storage)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(reviewArtwork(db, actor, other, command, storage)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await readArtwork(db, other, ['grilled chicken'])).toEqual([]);
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [other]);
    expect(
      (
        await db.query('SELECT * FROM app_private.ingredient_artwork_current WHERE tenant_id=$1', [
          venue,
        ])
      ).rowCount,
    ).toBe(0);
    await db.query('ROLLBACK');
  });
  it('failed upload leaves no approved state and concurrent first reviews conflict', async () => {
    const failed = input('apple');
    await expect(
      reviewArtwork(db, actor, venue, failed, {
        put: async () => {
          throw Error('storage down');
        },
      }),
    ).rejects.toThrow('storage down');
    expect(await readArtwork(db, venue, ['apple'])).toEqual([]);
    expect(
      (
        await admin.query(
          'SELECT * FROM app_private.es_command WHERE tenant_id=$1 AND idempotency_key=$2',
          [venue, failed.commandId],
        )
      ).rowCount,
    ).toBe(0);
    const second = new Client({ connectionString: runtimeUrl });
    await second.connect();
    try {
      const results = await Promise.allSettled([
        reviewArtwork(db, actor, venue, input('coconut'), storage),
        reviewArtwork(second, actor, venue, input('coconut'), storage),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'version_conflict' });
    } finally {
      await second.end();
    }
  });
});

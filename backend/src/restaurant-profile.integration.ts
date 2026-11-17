import { createHash } from 'node:crypto';
import { RestaurantProfileFieldsSchema } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOwnerRestaurant } from './bundle-producer/restaurant';
import { createApp } from './index';
import {
  readRestaurantProfile,
  readRestaurantSetup,
  replayRestaurantProfile,
  saveRestaurantProfile,
  storeRestaurantPhoto,
} from './restaurant-profile';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
describe.skipIf(!runtimeUrl || !adminUrl)('Restaurant profile persistence and authority', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  const venue = crypto.randomUUID(),
    other = crypto.randomUUID(),
    actor = crypto.randomUUID(),
    viewer = crypto.randomUUID();
  const fields = RestaurantProfileFieldsSchema.parse({
    name: 'Ember & Stone',
    city: 'San Francisco',
    street: '100 Fictional Street',
    line2: '',
    phone: '(555) 234-5678',
    email: 'owner@example.test',
  });
  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
    await admin.query(
      "INSERT INTO app_private.venues(id,name) VALUES($1,'Private profile test'),($2,'Other private profile test')",
      [venue, other],
    );
    await admin.query(
      "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner'),($1,$3,'viewer')",
      [venue, actor, viewer],
    );
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  it('saves, resumes, replays and reports submitted details without owner-supplied verification', async () => {
    expect(await readRestaurantProfile(runtime, actor, venue)).toBeNull();
    expect((await readRestaurantSetup(runtime, actor, venue)).detailsStatus).toBe('missing');
    const input = { commandId: crypto.randomUUID(), expectedVersion: 0, fields };
    const saved = await saveRestaurantProfile(runtime, actor, venue, input);
    expect(saved).toEqual({ version: 1, fields, status: 'submitted' });
    expect(await readRestaurantProfile(runtime, actor, venue)).toEqual(saved);
    expect(await saveRestaurantProfile(runtime, actor, venue, input)).toEqual(saved);
    await expect(
      saveRestaurantProfile(runtime, actor, venue, {
        ...input,
        fields: { ...fields, name: 'Changed' },
      }),
    ).rejects.toMatchObject({ code: 'command_conflict' });
    await expect(
      saveRestaurantProfile(runtime, actor, venue, { ...input, commandId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const events = await admin.query(
      "SELECT version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_type='restaurant_profile' ORDER BY version",
      [venue],
    );
    expect(events.rowCount).toBe(1);
    expect(replayRestaurantProfile(events.rows)).toEqual(saved);
    expect(await readRestaurantSetup(runtime, actor, venue)).toMatchObject({
      restaurantName: 'Ember & Stone',
      detailsStatus: 'submitted',
      menuAdded: false,
      menuVerified: false,
      published: false,
    });
    await expect(readRestaurantProfile(runtime, actor, other)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(readRestaurantProfile(runtime, viewer, venue)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('keeps verification trusted and invalidates it on changed details', async () => {
    await runtime.query('BEGIN');
    await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [venue]);
    await expect(
      runtime.query(
        "UPDATE app_private.restaurant_profile SET status='verified' WHERE tenant_id=$1",
        [venue],
      ),
    ).rejects.toThrow(/permission denied/);
    await runtime.query('ROLLBACK');
    await admin.query(
      "UPDATE app_private.restaurant_profile SET status='verified' WHERE tenant_id=$1",
      [venue],
    );
    const saved = await saveRestaurantProfile(runtime, actor, venue, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      fields: { ...fields, phone: '(555) 234-5679' },
    });
    expect(saved.status).toBe('submitted');
  });
  it('hash-binds private photo retries and refuses a reused upload key with different bytes', async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
    const upload = {
      bytes,
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
      idempotencyKey: crypto.randomUUID(),
    };
    let stored: ArrayBuffer | null = null;
    const put = vi.fn(async (_key: string, value: ArrayBuffer) => {
      stored = value;
    });
    const read = async () => stored;
    const photo = await storeRestaurantPhoto(runtime, actor, venue, upload, 'image/png', put, read);
    expect(
      await storeRestaurantPhoto(runtime, actor, venue, upload, 'image/png', put, read),
    ).toEqual(photo);
    expect(put).toHaveBeenCalledTimes(1);
    const changed = Uint8Array.from([...bytes, 3]);
    await expect(
      storeRestaurantPhoto(
        runtime,
        actor,
        venue,
        {
          ...upload,
          bytes: changed,
          sourceHash: createHash('sha256').update(changed).digest('hex'),
        },
        'image/png',
        put,
      ),
    ).rejects.toMatchObject({ code: 'command_conflict' });
    await expect(
      storeRestaurantPhoto(runtime, viewer, venue, upload, 'image/png', put),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      storeRestaurantPhoto(
        runtime,
        actor,
        venue,
        { ...upload, idempotencyKey: crypto.randomUUID(), bytes: Uint8Array.from([1, 2, 3]) },
        'image/png',
        put,
      ),
    ).rejects.toMatchObject({ code: 'invalid_photo' });
  });
  it('exports the canonical Screen 5 photo without a second profile projection or private fields', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJElEQVR4nO3MMQEAAAgDoEU0ju01hIcPBCABADiarrkeAEA+LbVgAsefyYE+AAAAAElFTkSuQmCC',
      'base64',
    );
    const objects = new Map<string, ArrayBuffer>();
    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const env = {
      APP_ENV: 'local',
      LOCAL_DATABASE_URL: runtimeUrl!,
      INGESTION_REPORTS_BUCKET: {
        put: async (key: string, value: ArrayBuffer) => {
          objects.set(key, value);
        },
        get: async (key: string) => {
          const value = objects.get(key);
          return value ? { arrayBuffer: async () => value } : null;
        },
      },
    };
    const origin = 'https://api.example.test';
    const uploadKey = crypto.randomUUID();
    const uploaded = await app.request(
      `${origin}/venues/${venue}/profile/photos`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'image/png',
          'Idempotency-Key': uploadKey,
        },
        body: bytes,
      },
      env,
    );
    expect(uploaded.status).toBe(201);
    const photo = (await uploaded.json()) as { id: string };
    const input = {
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      fields: { ...fields, photoId: photo.id },
    };
    const save = () =>
      app.request(
        `${origin}/venues/${venue}/profile`,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
        env,
      );
    const saved = await save();
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { profile: { version: number } }).profile.version).toBe(3);
    expect((await save()).status).toBe(200);
    const exported = await loadOwnerRestaurant(
      origin,
      'synthetic',
      venue,
      'https://assets.example.test',
      ((url, init) => app.request(String(url), init, env)) as typeof fetch,
    );
    expect(exported.logoFile?.bytes).toEqual(Uint8Array.from(bytes));
    expect(exported.restaurant.logo).toMatchObject({ width: 32, height: 32 });
    expect(exported.restaurant.name).toBe(fields.name);
    expect(JSON.stringify(exported.restaurant)).not.toContain(fields.street);
    expect(JSON.stringify(exported.restaurant)).not.toContain(fields.phone);
    expect(JSON.stringify(exported.restaurant)).not.toContain(fields.email);
    for (const key of [uploadKey, crypto.randomUUID()]) {
      objects.clear();
      const repaired = await app.request(
        `${origin}/venues/${venue}/profile/photos`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer synthetic',
            'Content-Type': 'image/png',
            'Idempotency-Key': key,
          },
          body: bytes,
        },
        env,
      );
      expect(repaired.status).toBe(201);
      expect(await repaired.json()).toEqual(photo);
      const recovered = await loadOwnerRestaurant(
        origin,
        'synthetic',
        venue,
        'https://assets.example.test',
        ((url, init) => app.request(String(url), init, env)) as typeof fetch,
      );
      expect(recovered.logoFile?.bytes).toEqual(Uint8Array.from(bytes));
    }
    const events = await admin.query(
      "SELECT version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_type='restaurant_profile' ORDER BY version",
      [venue],
    );
    expect(events.rows.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(replayRestaurantProfile(events.rows)).toEqual(
      await readRestaurantProfile(runtime, actor, venue),
    );
    expect(
      (await admin.query("SELECT to_regclass('app_private.restaurant_profile_current') AS legacy"))
        .rows[0].legacy,
    ).toBeNull();
    expect(
      (
        await app.request(
          `${origin}/venues/${venue}/restaurant-profile`,
          { headers: { Authorization: 'Bearer synthetic' } },
          env,
        )
      ).status,
    ).toBe(404);
    await expect(
      saveRestaurantProfile(runtime, actor, venue, {
        ...input,
        commandId: crypto.randomUUID(),
        expectedVersion: 3,
        fields: { ...fields, photoId: crypto.randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'photo_not_found' });
    const row = (
      await admin.query(
        'SELECT storage_key FROM app_private.restaurant_profile_photo WHERE tenant_id=$1 AND id=$2',
        [venue, photo.id],
      )
    ).rows[0];
    objects.set(row.storage_key, new Uint8Array(bytes.length).buffer);
    await expect(
      loadOwnerRestaurant(origin, 'synthetic', venue, 'https://assets.example.test', ((url, init) =>
        app.request(String(url), init, env)) as typeof fetch),
    ).rejects.toThrow('Owner logo unavailable');
  });

  it('exposes exact console CORS while preserving authentication, tenant and schema checks', async () => {
    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const env = { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl! };
    const url = `https://test/venues/${venue}/profile`;
    expect((await app.request(url, {}, env)).status).toBe(401);
    expect(
      (
        await app.request(
          `https://test/venues/${other}/setup`,
          { headers: { Authorization: 'Bearer synthetic' } },
          env,
        )
      ).status,
    ).toBe(403);
    const get = await app.request(
      url,
      { headers: { Authorization: 'Bearer synthetic', Origin: 'http://127.0.0.1:5174' } },
      env,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5174');
    const forbidden = await app.request(
      url,
      {
        method: 'OPTIONS',
        headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'PUT' },
      },
      env,
    );
    expect(forbidden.headers.get('access-control-allow-origin')).toBeNull();
    const invalid = await app.request(
      url,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedVersion: 2,
          fields,
          status: 'verified',
        }),
      },
      env,
    );
    expect(invalid.status).toBe(400);
  });
});

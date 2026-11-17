import { createHash } from 'node:crypto';
import { OwnerDishFieldsSchema } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  promoteDraftPhoto,
  saveOwnerDishDraft,
  storeDraftPhoto,
  verifyOwnerDish,
} from './owner-menu';
import { prepareOwnerMenu, readPreparedAsset, readPreparedBundle } from './owner-prepare';
import { fetchPreparedMenu, listPreparedMenus } from './owner-publication';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
const origin = 'https://api.example.test';

// A real 2 x 3 PNG header (the size is read from IHDR; the rest is not decoded).
function png() {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  );
  new DataView(bytes.buffer).setUint32(16, 2);
  new DataView(bytes.buffer).setUint32(20, 3);
  bytes[39] = Math.floor(Math.random() * 255);
  return bytes;
}

describe.skipIf(!runtimeUrl || !adminUrl)('owner-prepared menus (real database)', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  const venue = crypto.randomUUID();
  const other = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const editor = crypto.randomUUID();
  const objects = new Map<string, ArrayBuffer>();
  const storage = {
    get: async (key: string) => {
      const value = objects.get(key);
      return value ? { arrayBuffer: async () => value.slice(0), size: value.byteLength } : null;
    },
    put: async (key: string, bytes: ArrayBuffer, options?: unknown) => {
      const onlyIf = (options as { onlyIf?: { etagDoesNotMatch?: string } } | undefined)?.onlyIf;
      if (onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      objects.set(key, bytes.slice(0));
      return {};
    },
    delete: async (key: string) => objects.delete(key),
  };

  async function verifiedDish(fields: Record<string, unknown>, withPhoto = true) {
    const id = crypto.randomUUID();
    const save = (value: Record<string, unknown>, expectedVersion: number) =>
      saveOwnerDishDraft(runtime, owner, venue, id, {
        commandId: crypto.randomUUID(),
        expectedVersion,
        fields: OwnerDishFieldsSchema.parse(value),
      });
    await save(fields, 0);
    let version = 1;
    if (withPhoto) {
      const bytes = png();
      const photo = await storeDraftPhoto(
        runtime,
        owner,
        venue,
        id,
        {
          bytes,
          sourceHash: createHash('sha256').update(bytes).digest('hex'),
          idempotencyKey: crypto.randomUUID(),
        },
        'image/png',
        storage.put,
      );
      await save({ ...fields, photoId: photo.id }, 1);
      version = 2;
      await promoteDraftPhoto(runtime, owner, venue, id, photo.id, crypto.randomUUID(), storage);
    }
    await verifyOwnerDish(runtime, owner, venue, id, crypto.randomUUID(), true, version);
    return id;
  }

  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
    await admin.query(
      `INSERT INTO app_private.venues(id,name) VALUES($1,'Synthetic Prepared Cafe'),($2,'Other synthetic')`,
      [venue, other],
    );
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner'),($1,$3,'editor')`,
      [venue, owner, editor],
    );
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it('turns verified dishes into a prepared menu S13 can preview, idempotently and owner-only', async () => {
    const full = {
      name: 'Fictional Lentil Soup',
      category: 'Soups',
      description: 'Slow cooked lentils.',
      priceAmount: '9.50',
      priceCurrency: 'CAD',
      ingredients: { status: 'confirmed', items: ['lentils'] },
      allergens: { status: 'confirmed', items: ['milk'] },
    };
    await verifiedDish(full);
    await verifiedDish({ ...full, name: 'Fictional Side Salad' }, false);
    // An unverified draft is never included.
    await saveOwnerDishDraft(runtime, owner, venue, crypto.randomUUID(), {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      fields: OwnerDishFieldsSchema.parse({ ...full, name: 'Unverified Fictional Stew' }),
    });

    await expect(prepareOwnerMenu(runtime, editor, venue, origin, storage)).rejects.toMatchObject({
      status: 403,
    });

    const first = await prepareOwnerMenu(runtime, owner, venue, origin, storage);
    // The salad has no approved photo, so it is published text-only.
    expect(first).toMatchObject({ status: 'inserted', completeDishes: 2 });
    expect(first.diagnostics).toEqual([]);
    const again = await prepareOwnerMenu(runtime, owner, venue, origin, storage);
    expect(again).toMatchObject({
      status: 'already_present',
      menuRevisionId: first.menuRevisionId,
    });

    const menus = await listPreparedMenus(runtime, owner, venue);
    const menu = menus.find((value) => value.menuRevisionId === first.menuRevisionId);
    expect(menu?.bundleUrl).toBe(
      `${origin}/public/prepared-bundles/${venue}/${first.menuId}/${first.menuRevisionId}.json`,
    );
    const content = await fetchPreparedMenu(menu!, fetch, {
      origin,
      read: async (key) => {
        const value = objects.get(key);
        return value ? new Uint8Array(value) : null;
      },
    });
    const names = content.categories.flatMap((category) =>
      category.dishes.flatMap((dish) => (dish.complete ? [dish.name] : [])),
    );
    expect(names.sort()).toEqual(['Fictional Lentil Soup', 'Fictional Side Salad']);
    expect(JSON.stringify(content)).not.toContain('Unverified');

    // Public reads: only this venue's admitted bundle and approved photo.
    expect(
      await readPreparedBundle(runtime, storage, venue, first.menuId, first.menuRevisionId),
    ).not.toBeNull();
    expect(
      await readPreparedBundle(runtime, storage, other, first.menuId, first.menuRevisionId),
    ).toBeNull();
    const dish = content.categories[0]?.dishes.find((value) => value.complete && value.images);
    if (!dish?.complete || !dish.images) throw new Error('expected a dish with a photo');
    const [, , , , photoId, hash] = new URL(dish.images.card.url).pathname.split('/');
    const asset = await readPreparedAsset(runtime, storage, venue, photoId!, hash!);
    expect(asset?.contentType).toBe('image/png');
    expect(await readPreparedAsset(runtime, storage, other, photoId!, hash!)).toBeNull();

    // Admission approved and published nothing.
    const approvals = await admin.query(
      'SELECT 1 FROM app_private.menu_approval WHERE tenant_id=$1',
      [venue],
    );
    expect(approvals.rowCount).toBe(0);
  });
});

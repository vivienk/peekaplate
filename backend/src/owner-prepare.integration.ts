import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { OwnerDishFieldsSchema, type PublicMenuContentBundle } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveDishDraftAtomic, createApp } from './index';
import {
  promoteDraftPhoto,
  saveOwnerDishDraft,
  setDraftRemoval,
  storeDraftPhoto,
  verifyOwnerDish,
} from './owner-menu';
import {
  type ApproveDraft,
  preparedDishId,
  prepareOwnerMenu,
  readPreparedAsset,
  readPreparedBundle,
  readPreparedLogo,
  readPreparedPreviewAsset,
} from './owner-prepare';
import { fetchPreparedMenu, listPreparedMenus } from './owner-publication';
import { approveMenuRevision, publishMenu, withdrawMenu } from './publication-command';
import { readRestaurantProfile, readRestaurantSetup } from './restaurant-profile';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
const origin = 'https://api.example.test';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// A real, decodable PNG (width x height, one random text chunk so every image hashes uniquely).
function png(width = 2, height = 3): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('tEXt', Buffer.from(`synthetic\0${crypto.randomUUID()}`)),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe.skipIf(!runtimeUrl || !adminUrl)('owner-prepared menus (real database)', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
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
  const owner = crypto.randomUUID();
  const editor = crypto.randomUUID();
  const approve: ApproveDraft = (client, actor, venue, draft, options) =>
    approveDishDraftAtomic(client, actor, venue, draft, options);
  const prepare = (venue: string, actor = owner, approval = approve) =>
    prepareOwnerMenu(runtime, actor, venue, origin, storage, approval);

  async function newVenue(name = 'Synthetic Prepared Cafe') {
    const venue = crypto.randomUUID();
    await admin.query('INSERT INTO app_private.venues(id,name) VALUES($1,$2)', [venue, name]);
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission)
       VALUES($1,$2,'owner'),($1,$3,'editor')`,
      [venue, owner, editor],
    );
    return venue;
  }

  async function draftVersion(venue: string, draft: string) {
    const row = await admin.query<{ draft_version: number }>(
      'SELECT draft_version FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2',
      [venue, draft],
    );
    return row.rows[0]!.draft_version;
  }

  async function addPhoto(venue: string, draft: string) {
    const bytes = png();
    const photo = await storeDraftPhoto(
      runtime,
      owner,
      venue,
      draft,
      { bytes, sourceHash: sha(bytes), idempotencyKey: crypto.randomUUID() },
      'image/png',
      storage.put,
    );
    await promoteDraftPhoto(runtime, owner, venue, draft, photo.id, crypto.randomUUID(), storage);
    return photo.id;
  }

  const verify = async (venue: string, draft: string) =>
    verifyOwnerDish(
      runtime,
      owner,
      venue,
      draft,
      crypto.randomUUID(),
      true,
      await draftVersion(venue, draft),
    );

  async function manualDish(venue: string, fields: Record<string, unknown>, withPhoto = true) {
    const id = crypto.randomUUID();
    const save = (value: Record<string, unknown>, expectedVersion: number) =>
      saveOwnerDishDraft(runtime, owner, venue, id, {
        commandId: crypto.randomUUID(),
        expectedVersion,
        fields: OwnerDishFieldsSchema.parse(value),
      });
    await save(fields, 0);
    if (withPhoto) {
      const photoId = await addPhoto(venue, id);
      await save({ ...fields, photoId }, 1);
    }
    await verify(venue, id);
    return id;
  }

  // An extracted dish with a reviewed (corrected) candidate on the job's active extraction.
  async function extractedDish(
    venue: string,
    corrected: (photoId: string | null) => Record<string, unknown>,
    withPhoto = true,
  ) {
    const job = crypto.randomUUID();
    const extraction = `extraction-${crypto.randomUUID()}`;
    const candidate = `candidate-${crypto.randomUUID()}`;
    const draft = crypto.randomUUID();
    const hash = 'c'.repeat(64);
    await admin.query(
      `INSERT INTO app_private.menu_ingestion_jobs
         (id, tenant_id, source_type, idempotency_key, status, finished_at, result_storage_key,
          review_result_storage_key, active_review_extraction_id)
       VALUES ($1, $2, 'text', $3, 'complete', now(), 'results/r', 'results/r', $4)`,
      [job, venue, `prepare-${job}`, extraction],
    );
    await admin.query(
      `INSERT INTO app_private.extraction_review_session
         (tenant_id, extraction_id, schema_version, pipeline_version, extraction_status, source_id,
          source_sha256, job_id, payload, created_by)
       VALUES ($1, $2, 2, '3', 'complete', $3, $4, $5, '{}'::jsonb, $6)`,
      [venue, extraction, `sha256:${hash}`, hash, job, owner],
    );
    await admin.query(
      `INSERT INTO app_private.dish_drafts
         (id, tenant_id, job_id, draft_id, candidate_id, draft_index, name, description, category,
          price_amount, price_currency, ingredients, source_id, source_text, evidence)
       VALUES ($1, $2, $3, $4, $4, 1, 'Fictional Extracted Noodles', 'Extracted description.',
               'Noodles', '12.00', 'CAD', '["extracted wheat","extracted egg"]'::jsonb,
               'source-1', 'Noodles 12', '{"page":1}'::jsonb)`,
      [draft, venue, job, candidate],
    );
    const photoId = withPhoto ? await addPhoto(venue, draft) : null;
    const fields = corrected(photoId);
    await admin.query(
      `INSERT INTO app_private.candidate_review_current
         (tenant_id, extraction_id, candidate_id, stream_id, version, revision_id, review_status,
          corrected_fields, edited_fields, incomplete_fields, reviewed_by)
       VALUES ($1, $2, $3, $4, 1, $5, 'corrected', $6::jsonb, $7, '{}', $8)`,
      [
        venue,
        extraction,
        candidate,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify(fields),
        Object.keys(fields),
        owner,
      ],
    );
    await verify(venue, draft);
    return { draft, photoId };
  }

  async function bundleOf(venue: string, revision: string): Promise<PublicMenuContentBundle> {
    const menus = await listPreparedMenus(runtime, owner, venue);
    const menu = menus.find((value) => value.menuRevisionId === revision);
    return fetchPreparedMenu(menu!, fetch, {
      origin,
      read: async (key) => {
        const value = objects.get(key);
        return value ? new Uint8Array(value) : null;
      },
    });
  }
  const dishes = (bundle: PublicMenuContentBundle) =>
    bundle.categories.flatMap((category) => category.dishes);

  const full = {
    name: 'Fictional Lentil Soup',
    category: 'Soups',
    description: 'Slow cooked lentils.',
    priceAmount: '9.50',
    priceCurrency: 'CAD',
    servingCount: 2,
    ingredients: { status: 'confirmed', items: ['lentils'] },
    allergens: { status: 'confirmed', items: ['milk'] },
  };

  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it('prepares canonical approved revisions with the Screen 5 logo, serving count and photos', async () => {
    const venue = await newVenue();
    const other = await newVenue('Other synthetic');
    // Screen 5: the saved profile name and logo (exact PNG bytes, hash-bound).
    const logo = png(8, 4);
    const logoId = crypto.randomUUID();
    const logoKey = `restaurant-profiles/${venue}/${logoId}/${sha(logo)}`;
    objects.set(logoKey, logo.slice().buffer);
    await admin.query(
      `INSERT INTO app_private.restaurant_profile_photo(tenant_id,id,source_hash,storage_key,content_type,size_bytes)
       VALUES($1,$2,$3,$4,'image/png',$5)`,
      [venue, logoId, sha(logo), logoKey, logo.byteLength],
    );
    await admin.query(
      `INSERT INTO app_private.restaurant_profile(tenant_id,version,fields) VALUES($1,1,$2::jsonb)`,
      [venue, JSON.stringify({ name: 'Synthetic Profile Bistro', photoId: logoId })],
    );

    const soup = await manualDish(venue, full);
    const salad = await manualDish(venue, { ...full, name: 'Fictional Side Salad' }, false);
    // P1: an explicit ingredient clear is kept, never restored from the extraction.
    const cleared = await extractedDish(venue, () => ({ ingredients: null }), false);
    // P2: the selected extracted photo and confirmed corrected allergens are carried.
    const chosen = await extractedDish(venue, (photoId) => ({
      name: 'Fictional Chosen Noodles',
      ingredients: ['rice noodles'],
      photo_id: photoId,
      allergens: { status: 'confirmed', items: ['egg', 'wheat'] },
      serving_count: 3,
    }));

    await expect(prepare(venue, editor)).rejects.toMatchObject({ status: 403 });
    const first = await prepare(venue);
    expect(first.status).toBe('inserted');
    expect(await prepare(venue)).toMatchObject({
      status: 'already_present',
      menuRevisionId: first.menuRevisionId,
    });

    const bundle = await bundleOf(venue, first.menuRevisionId);
    // Canonical identities: each dish is the approved dish_current revision of its draft.
    const current = await admin.query<{ dish_id: string; revision_id: string }>(
      'SELECT dish_id, revision_id FROM app_private.dish_current WHERE tenant_id=$1',
      [venue],
    );
    const revisionOf = new Map(current.rows.map((row) => [row.dish_id, row.revision_id]));
    for (const dish of dishes(bundle))
      expect(dish.dish_revision_id).toBe(revisionOf.get(dish.dish_id));
    const byId = new Map(dishes(bundle).map((dish) => [dish.dish_id, dish]));
    const soupDish = byId.get(await preparedDishId(venue, soup));
    const saladDish = byId.get(await preparedDishId(venue, salad));
    const clearedDish = byId.get(await preparedDishId(venue, cleared.draft));
    const chosenDish = byId.get(await preparedDishId(venue, chosen.draft));

    // #215 mappings: Screen 5 name and logo, approved serving count.
    expect(bundle.restaurant.name).toBe('Synthetic Profile Bistro');
    expect(bundle.restaurant.logo).toMatchObject({
      url: `${origin}/public/prepared-assets/${venue}/logo/${sha(logo)}.png`,
      width: 8,
      height: 4,
      alt: 'Synthetic Profile Bistro logo',
    });
    expect(soupDish).toMatchObject({ complete: true, serving_count: 2, allergens: ['milk'] });
    if (!soupDish?.complete || !soupDish.images) throw new Error('expected a soup photo');
    expect(soupDish.images.card).toMatchObject({ width: 2, height: 3 });
    // A dish without a photo is the agreed text-only fallback.
    expect(saladDish).toMatchObject({ complete: true, images: null });
    // P1: cleared ingredients stay cleared (an incomplete placeholder), never the extraction's.
    expect(clearedDish).toEqual({
      dish_id: await preparedDishId(venue, cleared.draft),
      dish_revision_id: expect.any(String),
      complete: false,
    });
    expect(JSON.stringify(bundle)).not.toContain('extracted wheat');
    expect(first.diagnostics).toContainEqual({
      dishId: await preparedDishId(venue, cleared.draft),
      code: 'ingredients_missing',
    });
    // P2: the owner's selected photo and confirmed corrected allergens, with serving count.
    expect(chosenDish).toMatchObject({
      complete: true,
      name: 'Fictional Chosen Noodles',
      allergens: ['egg', 'wheat'],
      serving_count: 3,
    });
    if (!chosenDish?.complete || !chosenDish.images) throw new Error('expected a chosen photo');
    expect(chosenDish.images.card.url).toContain(`/${chosen.photoId}/`);

    const foreignOwner = crypto.randomUUID();
    await admin.query(
      "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner')",
      [other, foreignOwner],
    );
    const app = createApp({
      verify: async (authorization) => (authorization === 'Bearer foreign' ? foreignOwner : owner),
      execute: async () => {
        throw new Error('not used');
      },
      listPreparedMenus: (actor, v) => listPreparedMenus(runtime, actor, v),
      fetchPreparedMenu: (menu) =>
        fetchPreparedMenu(menu, fetch, {
          origin,
          read: async (key) => (objects.has(key) ? new Uint8Array(objects.get(key)!) : null),
        }),
      readPreparedBundle: (v, m, r) => readPreparedBundle(runtime, storage, v, m, r),
      readPreparedAsset: (v, p, hash) => readPreparedAsset(runtime, storage, v, p, hash),
      readPreparedLogo: (v, hash, extension) =>
        readPreparedLogo(runtime, storage, v, hash, extension),
      readPreparedPreviewAsset: (actor, content, host, asset, file) =>
        readPreparedPreviewAsset(runtime, storage, actor, content, host, asset, file),
    });
    // Preparation is private until the exact snapshot is explicitly published.
    const [, , , , photoId, hash] = new URL(soupDish.images.card.url).pathname.split('/');
    const publicPaths = [
      `/public/prepared-bundles/${venue}/${first.menuId}/${first.menuRevisionId}.json`,
      `/public/prepared-assets/${venue}/${photoId}/${hash}`,
      `/public/prepared-assets/${venue}/logo/${sha(logo)}.png`,
    ];
    for (const path of publicPaths) expect((await app.request(path)).status).toBe(404);
    const privateBase = `${origin}/venues/${venue}/prepared-menus/${first.menuId}/${first.menuRevisionId}`;
    for (const suffix of [`${photoId}/${hash}`, `logo/${sha(logo)}.png`]) {
      const response = await app.request(
        `${privateBase}/assets/${suffix}`,
        { headers: { Authorization: 'Bearer owner' } },
        { APP_ENV: 'local' },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(
        (
          await app.request(
            `${privateBase}/assets/${suffix}`,
            { headers: { Authorization: 'Bearer foreign' } },
            { APP_ENV: 'local' },
          )
        ).status,
      ).toBe(403);
    }
    expect(
      await readPreparedBundle(runtime, storage, venue, first.menuId, first.menuRevisionId),
    ).toBeNull();
    expect(await readPreparedAsset(runtime, storage, venue, photoId!, hash!)).toBeNull();
    expect(await readPreparedLogo(runtime, storage, venue, sha(logo), 'png')).toBeNull();
    for (const table of ['menu_approval', 'menu_publication_current'])
      expect(
        (await admin.query(`SELECT 1 FROM app_private.${table} WHERE tenant_id=$1`, [venue]))
          .rowCount,
      ).toBe(0);
    const [menu] = await listPreparedMenus(runtime, owner, venue);
    const approval = await approveMenuRevision(runtime, owner, venue, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      menuId: menu!.menuId,
      menuRevisionId: menu!.menuRevisionId,
      contentApprovalId: menu!.contentApprovalId,
      assetApprovalId: menu!.assetApprovalId,
    });
    await publishMenu(runtime, owner, venue, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      menuId: menu!.menuId,
      approvalId: approval.approvalId,
    });
    for (const path of publicPaths) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(
      await readPreparedBundle(runtime, storage, venue, first.menuId, first.menuRevisionId),
    ).not.toBeNull();
    expect(
      await readPreparedBundle(runtime, storage, other, first.menuId, first.menuRevisionId),
    ).toBeNull();
    expect((await readPreparedAsset(runtime, storage, venue, photoId!, hash!))?.contentType).toBe(
      'image/png',
    );
    expect(await readPreparedAsset(runtime, storage, other, photoId!, hash!)).toBeNull();
    expect((await readPreparedLogo(runtime, storage, venue, sha(logo), 'png'))?.bytes).toEqual(
      logo,
    );
    expect(await readPreparedLogo(runtime, storage, venue, sha(logo), 'jpg')).toBeNull();
    expect(await readPreparedLogo(runtime, storage, other, sha(logo), 'png')).toBeNull();

    // Uploading another private logo does not select it into the admitted snapshot.
    const unused = png(6, 3);
    const unusedId = crypto.randomUUID();
    const unusedKey = `restaurant-profiles/${venue}/${unusedId}/${sha(unused)}`;
    objects.set(unusedKey, unused.slice().buffer);
    await admin.query(
      `INSERT INTO app_private.restaurant_profile_photo(tenant_id,id,source_hash,storage_key,content_type,size_bytes)
       VALUES($1,$2,$3,$4,'image/png',$5)`,
      [venue, unusedId, sha(unused), unusedKey, unused.byteLength],
    );
    expect(
      (await app.request(`/public/prepared-assets/${venue}/logo/${sha(unused)}.png`)).status,
    ).toBe(404);
    // A new profile selection cannot change which logo the earlier snapshot admitted.
    await admin.query(
      "UPDATE app_private.restaurant_profile SET fields=fields || jsonb_build_object('photoId',$2::text) WHERE tenant_id=$1",
      [venue, unusedId],
    );
    expect(await readPreparedLogo(runtime, storage, venue, sha(unused), 'png')).toBeNull();
    expect((await readPreparedLogo(runtime, storage, venue, sha(logo), 'png'))?.bytes).toEqual(
      logo,
    );
    const preparedKey = `prepared-menus/${venue}/${first.menuId}/${first.menuRevisionId}.json`;
    const savedBytes = objects.get(preparedKey)!;
    const tampered = structuredClone(bundle);
    tampered.restaurant.logo!.url =
      `${origin}/public/prepared-assets/${venue}/logo/${sha(unused)}.png`;
    objects.set(
      preparedKey,
      Uint8Array.from(new TextEncoder().encode(JSON.stringify(tampered))).buffer,
    );
    expect(await readPreparedLogo(runtime, storage, venue, sha(unused), 'png')).toBeNull();
    objects.set(preparedKey, savedBytes);

    await withdrawMenu(runtime, owner, venue, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      menuId: first.menuId,
    });
    for (const path of publicPaths) expect((await app.request(path)).status).toBe(404);
    expect(
      await readPreparedBundle(runtime, storage, venue, first.menuId, first.menuRevisionId),
    ).toBeNull();
    expect(await readPreparedAsset(runtime, storage, venue, photoId!, hash!)).toBeNull();
    expect(await readPreparedLogo(runtime, storage, venue, sha(logo), 'png')).toBeNull();
  });

  it('keeps a fresh owner workspace empty without inventing prepared content or success', async () => {
    const venue = await newVenue('Fresh Synthetic Workspace');
    expect(await readRestaurantProfile(runtime, owner, venue)).toBeNull();
    expect(await readRestaurantSetup(runtime, owner, venue)).toMatchObject({
      detailsStatus: 'missing',
      menuAdded: false,
      menuVerified: false,
      published: false,
    });
    await expect(prepare(venue)).rejects.toMatchObject({ code: 'nothing_to_prepare' });
    expect(await listPreparedMenus(runtime, owner, venue)).toEqual([]);
    expect(
      (await admin.query('SELECT id FROM app_private.dish_drafts WHERE tenant_id=$1', [venue]))
        .rowCount,
    ).toBe(0);
  });

  it('refuses while any active dish is unverified, and an editor cannot prepare', async () => {
    const venue = await newVenue();
    await manualDish(venue, full);
    await saveOwnerDishDraft(runtime, owner, venue, crypto.randomUUID(), {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      fields: OwnerDishFieldsSchema.parse({ ...full, name: 'Unverified Fictional Stew' }),
    });
    await expect(prepare(venue)).rejects.toMatchObject({ code: 'menu_not_verified' });
    await expect(prepare(venue, editor)).rejects.toMatchObject({ status: 403 });
  });

  it('recovers a partial failure: a retry keeps the approved dishes and their IDs', async () => {
    const venue = await newVenue();
    const one = await manualDish(venue, { ...full, name: 'Fictional First Dish' });
    const two = await manualDish(venue, { ...full, name: 'Fictional Second Dish' });
    let calls = 0;
    const failing: ApproveDraft = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('synthetic connection lost');
      return approve(...args);
    };
    await expect(prepare(venue, owner, failing)).rejects.toThrow('synthetic connection lost');
    const accepted = await admin.query(
      `SELECT 1 FROM app_private.dish_drafts WHERE tenant_id=$1 AND review_status='accepted'`,
      [venue],
    );
    expect(accepted.rowCount).toBe(1);
    const firstApproved = await admin.query<{ dish_id: string; revision_id: string }>(
      'SELECT dish_id, revision_id FROM app_private.dish_current WHERE tenant_id=$1',
      [venue],
    );

    const retried = await prepare(venue);
    expect(retried.completeDishes).toBe(2);
    const bundle = await bundleOf(venue, retried.menuRevisionId);
    expect(
      dishes(bundle)
        .map((dish) => dish.dish_id)
        .sort(),
    ).toEqual([await preparedDishId(venue, one), await preparedDishId(venue, two)].sort());
    // The dish approved before the failure keeps its canonical ID and revision.
    const kept = dishes(bundle).find((dish) => dish.dish_id === firstApproved.rows[0]!.dish_id);
    expect(kept?.dish_revision_id).toBe(firstApproved.rows[0]!.revision_id);
  });

  it('keeps Back/Edit open after preparation: an edit reopens the dish onto the same dish ID', async () => {
    const venue = await newVenue();
    const soup = await manualDish(venue, full);
    const removable = await manualDish(venue, { ...full, name: 'Fictional Removable Dish' }, false);
    const first = await prepare(venue);
    const dishId = await preparedDishId(venue, soup);
    const before = dishes(await bundleOf(venue, first.menuRevisionId)).find(
      (dish) => dish.dish_id === dishId,
    );

    // Edit: an approved draft accepts the owner's edit and a new photo, and needs re-verification.
    await saveOwnerDishDraft(runtime, owner, venue, soup, {
      commandId: crypto.randomUUID(),
      expectedVersion: await draftVersion(venue, soup),
      fields: OwnerDishFieldsSchema.parse({ ...full, name: 'Fictional Lentil Soup, Edited' }),
    });
    await addPhoto(venue, soup);
    const reopened = await admin.query(
      'SELECT review_status, verification_status, published_dish_id FROM app_private.dish_drafts WHERE id=$1',
      [soup],
    );
    expect(reopened.rows[0]).toEqual({
      review_status: 'pending',
      verification_status: 'not_verified',
      published_dish_id: dishId,
    });
    await expect(prepare(venue)).rejects.toMatchObject({ code: 'menu_not_verified' });

    // Removal of an approved dish also works, and takes it off the next menu.
    await setDraftRemoval(runtime, owner, venue, removable, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: await draftVersion(venue, removable),
      expectedRemovalVersion: 0,
      removed: true,
    });

    await verify(venue, soup);
    const second = await prepare(venue);
    expect(second.menuRevisionId).not.toBe(first.menuRevisionId);
    const after = dishes(await bundleOf(venue, second.menuRevisionId));
    expect(after.map((dish) => dish.dish_id)).toEqual([dishId]);
    expect(after[0]).toMatchObject({ complete: true, name: 'Fictional Lentil Soup, Edited' });
    // Same canonical dish, new approved revision.
    expect(after[0]?.dish_revision_id).not.toBe(before?.dish_revision_id);
    const versions = await admin.query<{ version: number }>(
      'SELECT version FROM app_private.dish_current WHERE tenant_id=$1 AND dish_id=$2',
      [venue, dishId],
    );
    expect(versions.rows[0]?.version).toBe(2);
  });

  it('keeps stable verification retries valid after prepare, remove and Undo without content changes', async () => {
    const venue = await newVenue();
    const draft = await manualDish(venue, full, false);
    const version = await draftVersion(venue, draft);
    const command = crypto.randomUUID();
    const verified = await verifyOwnerDish(runtime, owner, venue, draft, command, true, version);
    await prepare(venue);
    const removal = {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: version,
      expectedRemovalVersion: 0,
      removed: true,
    };
    const removed = await setDraftRemoval(runtime, owner, venue, draft, removal);
    expect(removed.verification_status).toBe('verified');
    await setDraftRemoval(runtime, owner, venue, draft, {
      ...removal,
      commandId: crypto.randomUUID(),
      expectedRemovalVersion: 1,
      removed: false,
    });
    expect(await verifyOwnerDish(runtime, owner, venue, draft, command, true, version)).toEqual(
      JSON.parse(JSON.stringify(verified)),
    );
    expect(await verifyOwnerDish(runtime, owner, venue, draft, command, true, version)).toEqual(
      JSON.parse(JSON.stringify(verified)),
    );
    const events = await admin.query(
      "SELECT id FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2 AND stream_type='owner_draft_verification'",
      [venue, draft],
    );
    expect(events.rowCount).toBe(2);
  });

  it('reuses a legacy public-approval dish association after edit, re-verification and preparation', async () => {
    const venue = await newVenue();
    const draft = await manualDish(venue, full, false);
    const legacy = await approveDishDraftAtomic(runtime, owner, venue, draft, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: await draftVersion(venue, draft),
      confirmed: true,
    });
    const canonical = legacy.publishedRevision.dishId;
    expect(canonical).not.toBe(await preparedDishId(venue, draft));
    const saved = await saveOwnerDishDraft(runtime, owner, venue, draft, {
      commandId: crypto.randomUUID(),
      expectedVersion: await draftVersion(venue, draft),
      fields: OwnerDishFieldsSchema.parse({ ...full, name: 'Legacy dish edited' }),
    });
    expect(saved.published_dish_id).toBe(canonical);
    await verify(venue, draft);
    const prepared = await prepare(venue);
    const bundle = await bundleOf(venue, prepared.menuRevisionId);
    expect(dishes(bundle)).toHaveLength(1);
    expect(dishes(bundle)[0]?.dish_id).toBe(canonical);
    expect(dishes(bundle)[0]?.dish_revision_id).not.toBe(legacy.publishedRevision.revisionId);
    expect(await prepare(venue)).toMatchObject({
      status: 'already_present',
      menuRevisionId: prepared.menuRevisionId,
    });
    const current = await admin.query(
      'SELECT dish_id,version FROM app_private.dish_current WHERE tenant_id=$1',
      [venue],
    );
    expect(current.rows).toEqual([{ dish_id: canonical, version: 2 }]);
  });
});

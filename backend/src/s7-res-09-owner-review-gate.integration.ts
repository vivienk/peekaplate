import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { OwnerDishFieldsSchema, type PublicMenuContentBundle } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveDishDraftAtomic, createApp } from './index';
import { persistExtractedDrafts } from './ingestion/repository';
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
  readPreparedBundle,
} from './owner-prepare';
import { fetchPreparedMenu, listPreparedMenus } from './owner-publication';
import {
  type ApproveMenuRevisionInput,
  approveMenuRevision,
  type PublishMenuInput,
  publishMenu,
} from './publication-command';
import { readRestaurantSetup } from './restaurant-profile';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
const origin = 'https://api.example.test';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

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

describe.skipIf(!runtimeUrl || !adminUrl)('S7-RES-09 owner review gate (real database)', () => {
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

  const approvePrepared = (actor: string, venue: string, input: ApproveMenuRevisionInput) =>
    approveMenuRevision(runtime, actor, venue, input, storage);
  const publishPrepared = (actor: string, venue: string, input: PublishMenuInput) =>
    publishMenu(runtime, actor, venue, input, storage);
  const owner = crypto.randomUUID();
  const foreignOwner = crypto.randomUUID();
  const approve: ApproveDraft = (client, actor, venue, draft, options) =>
    approveDishDraftAtomic(client, actor, venue, draft, options);
  const prepare = (venue: string, actor = owner) =>
    prepareOwnerMenu(runtime, actor, venue, origin, storage, approve);

  async function newVenue(name = 'Synthetic Review Gate Cafe') {
    const venue = crypto.randomUUID();
    await admin.query('INSERT INTO app_private.venues(id,name) VALUES($1,$2)', [venue, name]);
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner')`,
      [venue, owner],
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

  async function seedExtractedJob(venue: string) {
    const jobId = crypto.randomUUID();
    const extractionId = `extraction-${crypto.randomUUID()}`;
    const claimToken = crypto.randomUUID();
    const hash = 'a'.repeat(64);
    await admin.query(
      `INSERT INTO app_private.menu_ingestion_jobs
         (id, tenant_id, source_type, source_hash, source_storage_key, idempotency_key, status,
          started_at, locked_by, locked_at, claim_token)
       VALUES ($1,$2,'pdf',$3,$4,$5,'running',now(),'worker-test',now(),$6)`,
      [jobId, venue, hash, `menus/${venue}/${jobId}.pdf`, crypto.randomUUID(), claimToken],
    );
    await admin.query(
      `INSERT INTO app_private.extraction_review_session
         (tenant_id, extraction_id, schema_version, pipeline_version, extraction_status, source_id,
          source_sha256, job_id, payload, created_by)
       VALUES ($1,$2,2,'3','complete',$3,$4,$5,'{}'::jsonb,$6)`,
      [venue, extractionId, `sha256:${hash}`, hash, jobId, owner],
    );
    return { jobId, extractionId, claimToken };
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

  const fullManual = {
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

  it('Scenario A: complete, high-confidence extracted dish stays unapproved until explicit owner approval, then publishes', async () => {
    const venue = await newVenue('Scenario A Cafe');
    const { jobId, extractionId, claimToken } = await seedExtractedJob(venue);

    const persisted = await persistExtractedDrafts(admin, {
      tenantId: venue,
      jobId,
      claimToken,
      drafts: [
        {
          draft_id: 'cand-a-1',
          candidate_id: 'cand-a-1',
          draft_index: 0,
          name: 'Fictional Herb Risotto',
          description: 'Creamy arborio rice with herbs.',
          category: 'Mains',
          price_text: '18.00 CAD',
          price_amount: '18.00',
          price_currency: 'CAD',
          ingredients: ['arborio rice', 'herbs', 'parmesan'],
          image_id: null,
          status: 'needs_review',
          source_id: 'src-1',
          source_text: 'Fictional Herb Risotto 18.00 CAD',
          code_point_spans: [{ segment_id: 'seg-1', start: 0, end: 10 }],
          utf16_spans: [{ segment_id: 'seg-1', start: 0, end: 10 }],
          review_warnings: [],
        },
      ],
    });
    expect(persisted.persistedCount).toBe(1);
    await admin.query(
      `UPDATE app_private.menu_ingestion_jobs
       SET status='complete', finished_at=now(), locked_by=NULL, locked_at=NULL, claim_token=NULL,
           active_review_extraction_id=$2, result_storage_key=$3, review_result_storage_key=$3
       WHERE id=$1`,
      [jobId, extractionId, `reports/${venue}/${jobId}/attempts/${extractionId}/extraction.json`],
    );

    const draftRow = (
      await admin.query<{
        id: string;
        extraction_status: string;
        review_status: string;
        verification_status: string;
      }>(
        'SELECT id, extraction_status, review_status, verification_status FROM app_private.dish_drafts WHERE tenant_id=$1',
        [venue],
      )
    ).rows[0]!;
    expect(draftRow.extraction_status).toBe('needs_review');
    expect(draftRow.review_status).toBe('pending');
    expect(draftRow.verification_status).toBe('not_verified');

    // Automatic extraction completion cannot prepare or publish.
    await expect(prepare(venue)).rejects.toMatchObject({ code: 'menu_not_verified', status: 409 });

    // Owner reviews and resolves allergens, then verifies the dish.
    const photoId = await addPhoto(venue, draftRow.id);
    await admin.query(
      `INSERT INTO app_private.candidate_review_current
         (tenant_id, extraction_id, candidate_id, stream_id, version, revision_id, review_status,
          corrected_fields, edited_fields, incomplete_fields, reviewed_by)
       VALUES ($1,$2,'cand-a-1',$3,1,$4,'corrected',$5::jsonb,$6,'{}',$7)`,
      [
        venue,
        extractionId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify({
          photo_id: photoId,
          allergens: { status: 'confirmed', items: ['milk'] },
        }),
        ['photo_id', 'allergens'],
        owner,
      ],
    );

    const verified = await verifyOwnerDish(
      runtime,
      owner,
      venue,
      draftRow.id,
      crypto.randomUUID(),
      true,
      await draftVersion(venue, draftRow.id),
    );
    expect(verified.draft.verification_status).toBe('verified');

    const prepared = await prepare(venue);
    const menu = (await listPreparedMenus(runtime, owner, venue)).find(
      (item) => item.menuRevisionId === prepared.menuRevisionId,
    )!;
    const approval = await approvePrepared(owner, venue, {
      commandId: crypto.randomUUID(),
      menuId: menu.menuId,
      expectedVersion: menu.reviewVersion,
      menuRevisionId: menu.menuRevisionId,
      contentApprovalId: menu.contentApprovalId,
      assetApprovalId: menu.assetApprovalId,
    });
    const pub = await publishPrepared(owner, venue, {
      commandId: crypto.randomUUID(),
      menuId: menu.menuId,
      expectedVersion: menu.publicationVersion,
      approvalId: approval.approvalId,
    });
    expect(pub.status).toBe('published');

    const bundleBytes = await readPreparedBundle(
      runtime,
      storage,
      venue,
      menu.menuId,
      menu.menuRevisionId,
    );
    expect(bundleBytes).not.toBeNull();
    const bundle = await bundleOf(venue, menu.menuRevisionId);
    expect(bundle.categories[0]!.dishes[0]).toMatchObject({
      name: 'Fictional Herb Risotto',
      allergens: ['milk'],
      complete: true,
    });
  });

  it('Scenario B: incomplete dish blocks verification, preparation, and publication even alongside a complete dish', async () => {
    const venue = await newVenue('Scenario B Cafe');
    const completeDraft = crypto.randomUUID();
    await saveOwnerDishDraft(runtime, owner, venue, completeDraft, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      fields: OwnerDishFieldsSchema.parse(fullManual),
    });
    await addPhoto(venue, completeDraft);
    await verifyOwnerDish(runtime, owner, venue, completeDraft, crypto.randomUUID(), true, 1);

    const incompleteDraft = crypto.randomUUID();
    await saveOwnerDishDraft(runtime, owner, venue, incompleteDraft, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      fields: OwnerDishFieldsSchema.parse({
        name: 'Fictional Unpriced Salad',
        category: 'Salads',
        priceAmount: null,
        priceCurrency: null,
        ingredients: { status: 'confirmed', items: ['lettuce'] },
        allergens: { status: 'unknown', items: [] },
      }),
    });

    await expect(
      verifyOwnerDish(runtime, owner, venue, incompleteDraft, crypto.randomUUID(), true, 1),
    ).rejects.toMatchObject({ code: 'draft_incomplete', status: 409 });
    await expect(prepare(venue)).rejects.toMatchObject({ code: 'menu_not_verified', status: 409 });

    // Owner corrects the missing fields, verifies, prepares, approves, and publishes.
    await saveOwnerDishDraft(runtime, owner, venue, incompleteDraft, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      fields: OwnerDishFieldsSchema.parse({
        ...fullManual,
        name: 'Fictional Priced Salad',
        category: 'Salads',
        allergens: { status: 'unknown', items: [] },
      }),
    });
    await verifyOwnerDish(runtime, owner, venue, incompleteDraft, crypto.randomUUID(), true, 2);

    const prepared = await prepare(venue);
    expect(prepared.completeDishes).toBe(2);
    const menu = (await listPreparedMenus(runtime, owner, venue)).find(
      (item) => item.menuRevisionId === prepared.menuRevisionId,
    )!;
    const approval = await approvePrepared(owner, venue, {
      commandId: crypto.randomUUID(),
      menuId: menu.menuId,
      expectedVersion: menu.reviewVersion,
      menuRevisionId: menu.menuRevisionId,
      contentApprovalId: menu.contentApprovalId,
      assetApprovalId: menu.assetApprovalId,
    });
    const pub = await publishPrepared(owner, venue, {
      commandId: crypto.randomUUID(),
      menuId: menu.menuId,
      expectedVersion: menu.publicationVersion,
      approvalId: approval.approvalId,
    });
    expect(pub.status).toBe('published');
  });

  it.each([
    { field: 'allergens', items: ['peanut'] },
    { field: 'ingredients', items: ['peanuts'] },
  ])('Scenario C: blocks proposed $field', async ({ field, items }) => {
    const venue = await newVenue('Scenario C Cafe');
    const draftId = crypto.randomUUID();
    await saveOwnerDishDraft(runtime, owner, venue, draftId, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      fields: OwnerDishFieldsSchema.parse({
        ...fullManual,
        name: 'Fictional Peanut Curry',
        [field]: { status: 'proposed', items },
      }),
    });

    await expect(
      verifyOwnerDish(runtime, owner, venue, draftId, crypto.randomUUID(), true, 1),
    ).rejects.toMatchObject({ code: 'draft_incomplete', status: 409 });
    await expect(
      approveDishDraftAtomic(runtime, owner, venue, draftId, {
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        expectedDraftVersion: 1,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'draft_incomplete', status: 409 });
    await expect(prepare(venue)).rejects.toMatchObject({
      code: 'menu_not_verified',
      status: 409,
    });

    // The owner resolves the proposed facts, then verifies and publishes.
    await saveOwnerDishDraft(runtime, owner, venue, draftId, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      fields: OwnerDishFieldsSchema.parse({
        ...fullManual,
        name: 'Fictional Peanut Curry',
        allergens: { status: 'confirmed', items: ['peanut'] },
      }),
    });
    await verifyOwnerDish(runtime, owner, venue, draftId, crypto.randomUUID(), true, 2);
    const prepared = await prepare(venue);
    const menu = (await listPreparedMenus(runtime, owner, venue)).find(
      (item) => item.menuRevisionId === prepared.menuRevisionId,
    )!;
    const approval = await approvePrepared(owner, venue, {
      commandId: crypto.randomUUID(),
      menuId: menu.menuId,
      expectedVersion: menu.reviewVersion,
      menuRevisionId: menu.menuRevisionId,
      contentApprovalId: menu.contentApprovalId,
      assetApprovalId: menu.assetApprovalId,
    });
    await publishPrepared(owner, venue, {
      commandId: crypto.randomUUID(),
      menuId: menu.menuId,
      expectedVersion: menu.publicationVersion,
      approvalId: approval.approvalId,
    });
    const bundle = await bundleOf(venue, menu.menuRevisionId);
    expect(bundle.categories[0]!.dishes[0]).toMatchObject({
      name: 'Fictional Peanut Curry',
      allergens: ['peanut'],
    });
  });

  it('Security & regression: blocks direct API manipulation, post-approval edits, extraction retries, and cross-venue access', async () => {
    const venue = await newVenue('Security Gate Cafe');
    const otherVenue = await newVenue('Foreign Cafe');
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner')`,
      [otherVenue, foreignOwner],
    );

    const draftId = crypto.randomUUID();
    await saveOwnerDishDraft(runtime, owner, venue, draftId, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      fields: OwnerDishFieldsSchema.parse(fullManual),
    });

    // HTTP layer rejects client-supplied verification_status manipulation on PUT /drafts/:draftId.
    const app = createApp({
      verify: async (auth) => auth.replace(/^Bearer\s+/i, ''),
      execute: async () => {
        throw new Error('not used');
      },
      prepareOwnerMenu: async (actorId, v) =>
        prepareOwnerMenu(runtime, actorId, v, origin, storage, approve),
      approve: approvePrepared,
      publish: publishPrepared,
    });
    const env = { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl! } as never;

    const spoofedDraftSave = await app.request(
      `/venues/${venue}/drafts/${draftId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedVersion: 1,
          fields: { ...fullManual, verification_status: 'verified' },
        }),
      },
      env,
    );
    expect(spoofedDraftSave.status).toBe(400);

    // Direct prepare/publish API calls without verification fail with 409.
    const directPrepare = await app.request(
      `/venues/${venue}/prepared-menus/prepare`,
      { method: 'POST', headers: { Authorization: `Bearer ${owner}` } },
      env,
    );
    expect(directPrepare.status).toBe(409);

    // Verify, prepare, and approve menu revision.
    await verifyOwnerDish(runtime, owner, venue, draftId, crypto.randomUUID(), true, 1);
    const prepared = await prepare(venue);
    const menu = (await listPreparedMenus(runtime, owner, venue)).find(
      (item) => item.menuRevisionId === prepared.menuRevisionId,
    )!;
    const approveInput = {
      commandId: crypto.randomUUID(),
      menuId: menu.menuId,
      expectedVersion: menu.reviewVersion,
      menuRevisionId: menu.menuRevisionId,
      contentApprovalId: menu.contentApprovalId,
      assetApprovalId: menu.assetApprovalId,
    };
    await expect(approveMenuRevision(runtime, owner, venue, approveInput)).rejects.toMatchObject({
      code: 'menu_not_verified',
      status: 409,
    });
    await expect(
      approveMenuRevision(runtime, owner, venue, approveInput, {
        ...storage,
        get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
      }),
    ).rejects.toMatchObject({ code: 'menu_not_verified', status: 409 });
    const approval = await approveMenuRevision(runtime, owner, venue, approveInput, storage);

    // Editing a dish AFTER prepare/approval reopens it and blocks publishMenu on the stale approval!
    await saveOwnerDishDraft(runtime, owner, venue, draftId, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      fields: OwnerDishFieldsSchema.parse({ ...fullManual, name: 'Edited After Approval' }),
    });
    expect(await readRestaurantSetup(runtime, owner, venue)).toMatchObject({
      menuAdded: true,
      menuVerified: false,
      published: false,
    });
    await expect(
      publishPrepared(owner, venue, {
        commandId: crypto.randomUUID(),
        menuId: menu.menuId,
        expectedVersion: menu.publicationVersion,
        approvalId: approval.approvalId,
      }),
    ).rejects.toMatchObject({ code: 'menu_not_verified', status: 409 });

    // Cross-restaurant authorization: foreignOwner cannot publish or verify venue's menu.
    await expect(
      publishPrepared(foreignOwner, venue, {
        commandId: crypto.randomUUID(),
        menuId: menu.menuId,
        expectedVersion: menu.publicationVersion,
        approvalId: approval.approvalId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    // Re-verify, re-prepare, re-approve, and publish succeeds.
    await verifyOwnerDish(runtime, owner, venue, draftId, crypto.randomUUID(), true, 2);
    const prepared2 = await prepare(venue);
    const menu2 = (await listPreparedMenus(runtime, owner, venue)).find(
      (item) => item.menuRevisionId === prepared2.menuRevisionId,
    )!;
    await expect(
      publishPrepared(owner, venue, {
        commandId: crypto.randomUUID(),
        menuId: menu.menuId,
        expectedVersion: menu2.publicationVersion,
        approvalId: approval.approvalId,
      }),
    ).rejects.toMatchObject({ code: 'menu_not_verified', status: 409 });
    const approval2 = await approvePrepared(owner, venue, {
      commandId: crypto.randomUUID(),
      menuId: menu2.menuId,
      expectedVersion: menu2.reviewVersion,
      menuRevisionId: menu2.menuRevisionId,
      contentApprovalId: menu2.contentApprovalId,
      assetApprovalId: menu2.assetApprovalId,
    });
    const publishInput = {
      commandId: crypto.randomUUID(),
      menuId: menu2.menuId,
      expectedVersion: menu2.publicationVersion,
      approvalId: approval2.approvalId,
    };
    const pub2 = await publishPrepared(owner, venue, publishInput);
    expect(pub2.status).toBe('published');

    await setDraftRemoval(runtime, owner, venue, draftId, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: 2,
      expectedRemovalVersion: 0,
      removed: true,
    });
    await expect(
      approvePrepared(owner, venue, {
        commandId: crypto.randomUUID(),
        menuId: menu2.menuId,
        expectedVersion: approval2.version,
        menuRevisionId: menu2.menuRevisionId,
        contentApprovalId: menu2.contentApprovalId,
        assetApprovalId: menu2.assetApprovalId,
      }),
    ).rejects.toMatchObject({ code: 'menu_not_verified', status: 409 });
    await expect(
      publishPrepared(owner, venue, {
        commandId: crypto.randomUUID(),
        menuId: menu2.menuId,
        expectedVersion: pub2.version,
        approvalId: approval2.approvalId,
      }),
    ).rejects.toMatchObject({ code: 'menu_not_verified', status: 409 });
    expect(await publishMenu(runtime, owner, venue, publishInput)).toEqual(pub2);
    expect(
      await readPreparedBundle(runtime, storage, venue, menu2.menuId, menu2.menuRevisionId),
    ).not.toBeNull();
  });
});

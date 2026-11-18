import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import {
  OwnerDishFieldsSchema,
  type PlateCalibration,
  SaveOwnerDishDraftSchema,
} from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApprovedDishSources } from './bundle-producer/repository';
import { createDishRevision, replayDish } from './dish-command';
import { approveDishDraftAtomic, createApp } from './index';
import { adaptPythonExtractionResult } from './ingestion/adapter';
import {
  acceptUploadGroupFile,
  changeMenuJob,
  createUploadGroup,
  dispatchReadyUploadGroup,
} from './ingestion/intake';
import { processIngestionQueueBatch } from './ingestion/orchestrator';
import { claimIngestionJob, getIngestionJob, persistExtractedDrafts } from './ingestion/repository';
import {
  promoteDraftPhoto,
  rejectDraftPhoto,
  replayOwnerDraft,
  replayOwnerDraftVerification,
  saveOwnerDishDraft,
  setDraftRemoval,
  storeDraftPhoto,
  verifyOwnerDish,
} from './owner-menu';
import { cleanupStagedMenuPhotos } from './owner-menu-retention';
import { previewKey } from './owner-portion-preview';
import { saveCandidateReviewCommand } from './review-command';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
describe.skipIf(!runtimeUrl || !adminUrl)('Owner menu workspace database', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  const venue = crypto.randomUUID();
  const other = crypto.randomUUID();
  const actor = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
    await admin.query(
      `INSERT INTO app_private.venues(id,name) VALUES($1,'Synthetic workspace'),($2,'Other synthetic workspace')`,
      [venue, other],
    );
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner'),($1,$3,'viewer')`,
      [venue, actor, viewer],
    );
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  const save = (
    draftId: string,
    fields = {},
    expectedVersion = 0,
    commandId = crypto.randomUUID(),
  ) =>
    saveOwnerDishDraft(runtime, actor, venue, draftId, {
      commandId,
      expectedVersion,
      fields: OwnerDishFieldsSchema.parse(fields),
    });
  const image = (key = crypto.randomUUID()) => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    return {
      bytes,
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
      sourceType: 'photo' as const,
      idempotencyKey: key,
    };
  };
  it('saves incomplete work and resumes exactly; command replay and event replay do not duplicate writes', async () => {
    const id = crypto.randomUUID();
    const command = crypto.randomUUID();
    const first = await save(id, {}, 0, command);
    expect(first.origin).toBe('manual');
    expect(first.name).toBeNull();
    expect(first.job_id).toBeNull();
    expect(first.source_text).toBeNull();
    expect(await save(id, {}, 0, command)).toEqual(JSON.parse(JSON.stringify(first)));
    await expect(save(id, { name: 'changed' }, 0, command)).rejects.toMatchObject({
      code: 'command_conflict',
    });
    await save(id, { name: 'Fictional soup' }, 1);
    await expect(save(id, {}, 1)).rejects.toMatchObject({ code: 'version_conflict' });
    const events = await admin.query(
      'SELECT version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2 ORDER BY version',
      [venue, id],
    );
    expect(events.rows).toHaveLength(2);
    expect(replayOwnerDraft(events.rows)?.name).toBe('Fictional soup');
    expect(
      (
        await admin.query(
          'SELECT id FROM app_private.outbox WHERE event_id IN (SELECT id FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2)',
          [venue, id],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('preserves explicit serving facts through legacy-shaped edits and replays without conflating clears', async () => {
    const id = crypto.randomUUID();
    await save(id, { name: 'Original soup', servingSize: '1 bowl', servingCount: 2 });
    const legacy = SaveOwnerDishDraftSchema.parse({
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      fields: { name: 'Legacy edited soup' },
    });
    const edited = await saveOwnerDishDraft(runtime, actor, venue, id, legacy);
    expect(edited.manual_fields).toMatchObject({
      name: 'Legacy edited soup',
      servingSize: '1 bowl',
      servingCount: 2,
    });
    expect(await saveOwnerDishDraft(runtime, actor, venue, id, legacy)).toEqual(
      JSON.parse(JSON.stringify(edited)),
    );
    const receipt = await admin.query(
      'SELECT request_hash FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venue, actor, legacy.commandId],
    );
    expect(receipt.rows[0].request_hash).toBe(
      createHash('sha256')
        .update(JSON.stringify({ commandType: 'owner.draft.save.v1', draftId: id, ...legacy }))
        .digest('hex'),
    );
    for (const clear of [{ servingSize: null }, { servingCount: null }])
      await expect(
        saveOwnerDishDraft(runtime, actor, venue, id, {
          ...legacy,
          fields: { ...legacy.fields, ...clear },
        }),
      ).rejects.toMatchObject({ code: 'command_conflict' });
    const cleared = await saveOwnerDishDraft(runtime, actor, venue, id, {
      ...legacy,
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      fields: { ...legacy.fields, servingSize: null, servingCount: null },
    });
    expect(cleared.manual_fields).toMatchObject({ servingSize: null, servingCount: null });
    expect(await saveOwnerDishDraft(runtime, actor, venue, id, legacy)).toEqual(
      JSON.parse(JSON.stringify(edited)),
    );
    const events = await admin.query(
      "SELECT version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2 AND stream_type='owner_draft' ORDER BY version",
      [venue, id],
    );
    expect(events.rows).toHaveLength(3);
    expect(replayOwnerDraft(events.rows.slice(0, 2))).toMatchObject({
      servingSize: '1 bowl',
      servingCount: 2,
    });
    expect(replayOwnerDraft(events.rows)).toMatchObject({ servingSize: null, servingCount: null });
  });
  it('denies cross-venue, viewers and revoked actors before replay', async () => {
    const id = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const input = { commandId, expectedVersion: 0, fields: OwnerDishFieldsSchema.parse({}) };
    await saveOwnerDishDraft(runtime, actor, venue, id, input);
    await expect(saveOwnerDishDraft(runtime, actor, other, id, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(saveOwnerDishDraft(runtime, viewer, venue, id, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await admin.query(
      "UPDATE app_private.staff_membership SET permission='viewer' WHERE tenant_id=$1 AND actor_id=$2",
      [venue, actor],
    );
    await expect(saveOwnerDishDraft(runtime, actor, venue, id, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await admin.query(
      "UPDATE app_private.staff_membership SET permission='owner' WHERE tenant_id=$1 AND actor_id=$2",
      [venue, actor],
    );
  });
  it('removes and restores the same private draft with separate replayable versions', async () => {
    const id = crypto.randomUUID();
    await save(id, { name: 'Fictional soup', servingSize: '1 bowl' });
    await verifyOwnerDish(runtime, actor, venue, id, crypto.randomUUID(), true, 1);
    const input = {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: 1,
      expectedRemovalVersion: 0,
      removed: true,
    };
    const removed = await setDraftRemoval(runtime, actor, venue, id, input);
    expect(removed.removed_at).not.toBeNull();
    expect(removed.draft_version).toBe(1);
    expect((await setDraftRemoval(runtime, actor, venue, id, input)).removal_version).toBe(1);
    await expect(save(id, { name: 'Overwritten' }, 1)).rejects.toMatchObject({
      code: 'draft_not_editable',
    });
    await expect(
      verifyOwnerDish(runtime, actor, venue, id, crypto.randomUUID(), true, 1),
    ).rejects.toMatchObject({ code: 'draft_not_editable' });
    await expect(
      setDraftRemoval(runtime, actor, venue, id, {
        ...input,
        commandId: crypto.randomUUID(),
        removed: false,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(setDraftRemoval(runtime, viewer, venue, id, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const restored = await setDraftRemoval(runtime, actor, venue, id, {
      ...input,
      commandId: crypto.randomUUID(),
      expectedRemovalVersion: 1,
      removed: false,
    });
    expect(restored.removed_at).toBeNull();
    expect(restored.manual_fields).toEqual(removed.manual_fields);
    expect(restored.verification_status).toBe('verified');
    await save(id, { name: 'Still editable', servingSize: '1 bowl' }, 1);
    const events = await admin.query(
      "SELECT version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2 AND stream_type='owner_draft' ORDER BY version",
      [venue, id],
    );
    expect(replayOwnerDraft(events.rows)?.servingSize).toBe('1 bowl');
    const lifecycle = await admin.query(
      "SELECT version,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2 AND stream_type='owner_draft_removal' ORDER BY version",
      [venue, id],
    );
    expect(lifecycle.rows.map((row) => [row.version, row.payload.removed])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('keeps photo ownership private and refuses a photo from another draft', async () => {
    const id = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    await save(id);
    await save(otherId);
    const put = vi.fn(async (_key: string, _bytes: ArrayBuffer) => {});
    const photo = await storeDraftPhoto(runtime, actor, venue, id, image(), 'image/png', put);
    const stable = image();
    await storeDraftPhoto(runtime, actor, venue, id, stable, 'image/png', put);
    const changed = { ...stable, bytes: Uint8Array.from([...stable.bytes, 4]) };
    changed.sourceHash = createHash('sha256').update(changed.bytes).digest('hex');
    await expect(
      storeDraftPhoto(runtime, actor, venue, id, changed, 'image/png', put),
    ).rejects.toMatchObject({ code: 'command_conflict' });
    expect(put.mock.calls[0]?.[0]).toBe(`menu-staging/${venue}/${id}/${image().sourceHash}`);
    expect((await storeDraftPhoto(runtime, actor, venue, id, image(), 'image/png', put)).id).toBe(
      photo.id,
    );

    await expect(save(otherId, { photoId: photo.id }, 1)).rejects.toMatchObject({
      code: 'photo_not_found',
    });
    await save(id, { photoId: photo.id }, 1);
    expect(
      (await admin.query('SELECT id FROM app_private.dish_draft_photo WHERE tenant_id=$1', [venue]))
        .rowCount,
    ).toBe(1);
  });
  it('approves only the current confirmed draft, freezing facts in a replayable dish revision without publishing', async () => {
    const id = crypto.randomUUID();
    await save(id, {
      name: 'Fictional soup',
      category: 'Soup',
      description: 'Fictional vegetables',
      servingSize: '2',
      priceAmount: '8.50',
      priceCurrency: 'USD',
      ingredients: { status: 'confirmed', items: ['Carrot'] },
      allergens: { status: 'unknown', items: [] },
    });
    await expect(
      approveDishDraftAtomic(runtime, actor, venue, id, { commandId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'draft_confirmation_required' });
    await expect(
      approveDishDraftAtomic(runtime, actor, venue, id, {
        commandId: crypto.randomUUID(),
        expectedDraftVersion: 2,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'draft_confirmation_required' });
    const commandId = crypto.randomUUID();
    const result = await approveDishDraftAtomic(runtime, actor, venue, id, {
      commandId,
      expectedDraftVersion: 1,
      confirmed: true,
    });
    expect(result.publishedRevision.facts?.ingredients).toEqual(['Carrot']);
    expect(result.publishedRevision.facts?.allergens).toBeNull();
    expect(result.publishedRevision.facts?.servingCount).toBe(2);
    expect(
      (await loadApprovedDishSources(runtime, venue, [result.publishedRevision.dishId])).get(
        result.publishedRevision.dishId,
      )?.reviewState,
    ).toBe('corrected');
    // Back/Edit (Part A): an edit after approval reopens the draft for re-verification. The
    // approved revision and its frozen facts are untouched until a new approval.
    expect(await save(id, { name: 'Changed' }, 1)).toMatchObject({
      review_status: 'pending',
      verification_status: 'not_verified',
      published_dish_id: result.publishedRevision.dishId,
    });
    const events = await admin.query(
      'SELECT tenant_id AS "tenantId",stream_type AS "streamType",stream_id AS "streamId",version,schema_version AS "schemaVersion",event_type AS "eventType",payload,metadata FROM app_private.es_event WHERE tenant_id=$1 AND stream_id=$2',
      [venue, result.publishedRevision.dishId],
    );
    expect(replayDish(events.rows)?.facts).toEqual(result.publishedRevision.facts);
    const again = await approveDishDraftAtomic(runtime, actor, venue, id, {
      commandId,
      expectedDraftVersion: 1,
      confirmed: true,
    });
    expect(again.publishedRevision.revisionId).toBe(result.publishedRevision.revisionId);
    expect(
      (
        await admin.query('SELECT * FROM app_private.menu_publication_current WHERE tenant_id=$1', [
          venue,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('preserves legacy command hashes and legacy event replay', async () => {
    const input = {
      commandId: crypto.randomUUID(),
      dishId: crypto.randomUUID(),
      expectedVersion: 0,
      name: 'Old shape',
      description: '',
    };
    const first = await createDishRevision(runtime, actor, venue, input);
    expect(await createDishRevision(runtime, actor, venue, input)).toEqual(first);
    expect(first.facts).toBeUndefined();
  });
  it('freezes people count with independent photo measurements and clears measurements after count edits', async () => {
    const draftId = crypto.randomUUID();
    const fields = {
      name: 'Measured synthetic soup',
      category: 'Soups',
      priceAmount: '9',
      priceCurrency: 'USD',
    };
    await save(draftId, fields);
    const photo = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      image(),
      'image/png',
      async () => {},
    );
    const calibration: PlateCalibration = {
      shape: 'round',
      width_mm: 280,
      depth_mm: 280,
      source_sha256: photo.source_hash,
      source_width_px: 800,
      source_height_px: 600,
      boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      confirmed: true,
    };
    await expect(
      save(
        draftId,
        {
          ...fields,
          photoId: photo.id,
          servingSize: '2',
          servingCount: 2,
          portionCalibration: { ...calibration, source_sha256: 'b'.repeat(64) },
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'portion_calibration_mismatch' });
    await save(
      draftId,
      {
        ...fields,
        photoId: photo.id,
        servingSize: '2',
        servingCount: 2,
        portionCalibration: calibration,
      },
      1,
    );
    const approve = () =>
      approveDishDraftAtomic(runtime, actor, venue, draftId, {
        commandId: crypto.randomUUID(),
        expectedDraftVersion: 2,
        confirmed: true,
      });
    await admin.query(
      "UPDATE app_private.dish_drafts SET manual_fields=jsonb_set(manual_fields,'{portionCalibration,source_sha256}',$3::jsonb) WHERE tenant_id=$1 AND id=$2",
      [venue, draftId, JSON.stringify('b'.repeat(64))],
    );
    await expect(approve()).rejects.toMatchObject({ code: 'portion_calibration_mismatch' });
    await admin.query(
      "UPDATE app_private.dish_drafts SET manual_fields=jsonb_set(manual_fields,'{portionCalibration,source_sha256}',$3::jsonb) WHERE tenant_id=$1 AND id=$2",
      [venue, draftId, JSON.stringify(photo.source_hash)],
    );
    const approved = await approve();
    expect(approved.publishedRevision.facts).toMatchObject({
      servingSize: '2',
      servingCount: 2,
      portionCalibration: calibration,
      photoId: photo.id,
    });
    expect(
      (await loadApprovedDishSources(runtime, venue, [approved.publishedRevision.dishId])).get(
        approved.publishedRevision.dishId,
      ),
    ).toMatchObject({ servingCount: 2, portionCalibration: calibration });
    expect(
      (await save(draftId, { ...fields, photoId: photo.id, servingCount: 3 }, 2)).manual_fields,
    ).toMatchObject({ servingSize: '2', servingCount: 3, portionCalibration: null });
    expect(
      (await loadApprovedDishSources(runtime, venue, [approved.publishedRevision.dishId])).get(
        approved.publishedRevision.dishId,
      ),
    ).toMatchObject({ servingCount: 2, portionCalibration: calibration });
  });
  it('replays an identical photo upload after approval without rewriting storage', async () => {
    const id = crypto.randomUUID();
    const fields = {
      name: 'Fictional soup',
      category: 'Soup',
      priceAmount: '8',
      priceCurrency: 'USD',
    };
    await save(id, fields);
    const upload = image();
    const put = vi.fn(async (_key: string, _bytes: ArrayBuffer) => {});
    const photo = await storeDraftPhoto(runtime, actor, venue, id, upload, 'image/png', put);
    await save(id, { ...fields, photoId: photo.id }, 1);
    const approved = await approveDishDraftAtomic(runtime, actor, venue, id, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: 2,
      confirmed: true,
    });
    expect(approved.publishedRevision.facts?.photoId).toBe(photo.id);
    expect((await storeDraftPhoto(runtime, actor, venue, id, upload, 'image/png', put)).id).toBe(
      photo.id,
    );
    expect(put).toHaveBeenCalledOnce();
    // Back/Edit (Part A): a different photo after approval reopens the draft instead of failing;
    // the approved revision keeps the photo it was approved with.
    const other = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
    const replaced = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      id,
      {
        bytes: other,
        sourceHash: createHash('sha256').update(other).digest('hex'),
        idempotencyKey: crypto.randomUUID(),
      },
      'image/png',
      put,
    );
    expect(replaced.id).not.toBe(photo.id);
    const reopened = await admin.query(
      'SELECT review_status, verification_status FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2',
      [venue, id],
    );
    expect(reopened.rows[0]).toEqual({
      review_status: 'pending',
      verification_status: 'not_verified',
    });
    const kept = await admin.query<{ approved_facts: { photoId: string } }>(
      'SELECT approved_facts FROM app_private.dish_current WHERE tenant_id=$1 AND dish_id=$2',
      [venue, approved.publishedRevision.dishId],
    );
    expect(kept.rows[0]?.approved_facts.photoId).toBe(photo.id);
  });
  it('exports a private portion only while its photo remains approved on the current dish revision', async () => {
    const draftId = crypto.randomUUID();
    const fields = {
      name: 'Fictional soup',
      category: 'Soup',
      priceAmount: '8.50',
      priceCurrency: 'USD',
    };
    const encode = (value: string) => new Uint8Array(Buffer.from(value));
    const objects = new Map<string, ArrayBuffer>();
    const storage = {
      get: async (key: string) => {
        const data = objects.get(key);
        return data ? { size: data.byteLength, arrayBuffer: async () => data.slice(0) } : null;
      },
      put: async (key: string, data: string | ArrayBuffer) => {
        objects.set(key, typeof data === 'string' ? encode(data).buffer : data);
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    };

    await save(draftId, fields);
    const original = image();
    const replacement = image();
    replacement.bytes[10] = 4;
    replacement.sourceHash = createHash('sha256').update(replacement.bytes).digest('hex');
    const photo = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      original,
      'image/png',
      storage.put,
    );
    const nextPhoto = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      replacement,
      'image/png',
      storage.put,
    );
    await save(draftId, { ...fields, photoId: photo.id }, 1);
    await promoteDraftPhoto(runtime, actor, venue, draftId, photo.id, crypto.randomUUID(), storage);
    await promoteDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      nextPhoto.id,
      crypto.randomUUID(),
      storage,
    );
    const { publishedRevision } = await approveDishDraftAtomic(runtime, actor, venue, draftId, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: 2,
      confirmed: true,
    });
    const { dishId, facts } = publishedRevision;
    if (!facts) throw new Error('Expected approved facts for the confirmed draft');
    expect(facts.photoId).toBe(photo.id);

    const key = previewKey(venue, draftId, photo.id, original.sourceHash);
    const layers = await Promise.all(
      [
        { name: 'background.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>', depth: 0 },
        { name: 'dish.webp', content: 'synthetic cutout', depth: 1 },
      ].map(async ({ name, content, depth }) => {
        const bytes = encode(content);
        await storage.put(`${key}/${name}`, bytes.buffer);
        return {
          url: `https://portion-ingestion.invalid/fixture/${name}`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size_bytes: bytes.byteLength,
          depth,
        };
      }),
    );
    await storage.put(
      `${key}/record.json`,
      JSON.stringify({
        status: 'needs_review',
        photo_sha256: original.sourceHash,
        dish_id: draftId,
        draft_revision_id: photo.id,
        portion: {
          schema_version: 1,
          dish_id: draftId,
          dish_revision_id: photo.id,
          width: 128,
          height: 128,
          layers,
        },
      }),
    );

    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const env = {
      APP_ENV: 'local',
      LOCAL_DATABASE_URL: runtimeUrl!,
      INGESTION_REPORTS_BUCKET: storage,
    };
    const path = `https://test/venues/${venue}/drafts/${draftId}/photos/${photo.id}/portion`;
    const headers = { Authorization: 'Bearer synthetic' };
    const exportPortion = () => app.request(`${path}/export`, { headers }, env);
    expect((await app.request(`${path}/approve`, { method: 'POST', headers }, env)).status).toBe(
      200,
    );

    const initial = await exportPortion();
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      dishId,
      dishRevisionId: publishedRevision.revisionId,
    });

    const revision = {
      dishId,
      name: 'Renamed fictional soup',
      description: publishedRevision.description,
    };
    const renamed = await createDishRevision(runtime, actor, venue, {
      ...revision,
      commandId: crypto.randomUUID(),
      expectedVersion: publishedRevision.version,
    });
    const afterRename = await app.request(
      `https://test/venues/${venue}/drafts/${draftId.toUpperCase()}/photos/${photo.id.toUpperCase()}/portion/export`,
      { headers },
      env,
    );
    expect(afterRename.status).toBe(200);
    expect(await afterRename.json()).toMatchObject({ dishId, dishRevisionId: renamed.revisionId });

    const replaced = await createDishRevision(runtime, actor, venue, {
      ...revision,
      commandId: crypto.randomUUID(),
      expectedVersion: renamed.version,
      facts: { ...facts, photoId: nextPhoto.id },
    });
    const afterReplacement = await exportPortion();
    await createDishRevision(runtime, actor, venue, {
      ...revision,
      commandId: crypto.randomUUID(),
      expectedVersion: replaced.version,
      facts: { ...facts, photoId: null },
    });
    const afterRemoval = await exportPortion();
    expect([afterReplacement.status, afterRemoval.status]).toEqual([409, 409]);
    expect(await afterReplacement.json()).toEqual({ error: 'approved_dish_revision_unavailable' });
    expect(await afterRemoval.json()).toEqual({ error: 'approved_dish_revision_unavailable' });

    await rejectDraftPhoto(runtime, actor, venue, draftId, photo.id, crypto.randomUUID());
    for (const url of [path, `${path}/approve`]) {
      const rejected = await app.request(url, { method: 'POST', headers }, env);
      expect(rejected.status).toBe(404);
      expect(await rejected.json()).toEqual({ error: 'photo_not_found' });
    }
  });
  it('retains reviewed facts through a legacy text-only edit instead of reopening draft fallback', async () => {
    const id = crypto.randomUUID();
    await save(id, {
      name: 'Fictional salad',
      category: 'Salad',
      priceAmount: '10',
      priceCurrency: 'USD',
      ingredients: { status: 'proposed', items: ['Unverified ingredient'] },
    });
    const accepted = await approveDishDraftAtomic(runtime, actor, venue, id, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: 1,
      confirmed: true,
    });
    const next = await createDishRevision(runtime, actor, venue, {
      dishId: accepted.publishedRevision.dishId,
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      name: 'Edited salad',
      description: 'Still unverified ingredients',
    });
    expect(next.facts?.ingredients).toBeNull();
    expect(next.facts?.allergens).toBeNull();
    const source = (await loadApprovedDishSources(runtime, venue, [next.dishId])).get(next.dishId);
    expect(source?.reviewState).toBe('corrected');
    expect(source?.ingredients).toBeNull();
  });
  it('keeps ordered group identity through retries and refuses a changed or truncated selection', async () => {
    const uploads = [image(), image()];
    uploads[1]!.bytes[10] = 4;
    uploads[1]!.sourceHash = createHash('sha256').update(uploads[1]!.bytes).digest('hex');
    const first = await createUploadGroup(runtime, actor, venue, uploads);
    expect((await createUploadGroup(runtime, actor, venue, uploads)).jobs.map((j) => j.id)).toEqual(
      first.jobs.map((j) => j.id),
    );
    await expect(createUploadGroup(runtime, actor, venue, [uploads[0]!])).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(
      createUploadGroup(
        runtime,
        actor,
        venue,
        [...uploads].reverse().map((u) => ({ ...u, idempotencyKey: uploads[0]!.idempotencyKey })),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const storage = { put: vi.fn(async () => {}) };
    const queue = { send: vi.fn(async () => {}) };
    expect(
      await claimIngestionJob(runtime, {
        tenantId: venue,
        jobId: first.jobs[0]!.id,
        workerId: 'fixture',
      }),
    ).toBeNull();
    const partial = await acceptUploadGroupFile(
      runtime,
      actor,
      venue,
      first.id,
      0,
      uploads[0]!,
      storage.put,
    );
    await dispatchReadyUploadGroup(partial, queue);
    expect(queue.send).not.toHaveBeenCalled();
    expect(
      await claimIngestionJob(runtime, {
        tenantId: venue,
        jobId: first.jobs[0]!.id,
        workerId: 'fixture',
      }),
    ).toBeNull();
    const ready = await acceptUploadGroupFile(
      runtime,
      actor,
      venue,
      first.id,
      1,
      uploads[1]!,
      storage.put,
    );
    await dispatchReadyUploadGroup(ready, queue);
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(queue.send).toHaveBeenCalledTimes(2);
  });
  it('fences a cancelled worker, ACKs cancelled redelivery without an archive and repairs retry dispatch idempotently', async () => {
    const upload = image();
    const group = await createUploadGroup(runtime, actor, venue, [upload]);
    await acceptUploadGroupFile(runtime, actor, venue, group.id, 0, upload, async () => {});
    const job = group.jobs[0]!;
    const claim = await claimIngestionJob(runtime, {
      tenantId: venue,
      jobId: job.id,
      workerId: 'fixture',
    });
    expect(claim).not.toBeNull();
    await changeMenuJob(runtime, actor, venue, job.id, crypto.randomUUID(), 'cancel');
    await expect(
      persistExtractedDrafts(runtime, {
        tenantId: venue,
        jobId: job.id,
        claimToken: claim!.claimToken,
        drafts: [],
      }),
    ).rejects.toMatchObject({ code: 'lease_expired_or_reclaimed' });
    const ack = vi.fn();
    const retry = vi.fn();
    const extractor = vi.fn();
    await processIngestionQueueBatch(
      runtime,
      {
        messages: [
          {
            body: {
              version: 1,
              tenantId: venue,
              jobId: job.id,
              queuedAt: new Date().toISOString(),
            },
            ack,
            retry,
          },
        ],
      },
      extractor,
      { reportStorage: { put: vi.fn(), get: vi.fn(async () => null) } },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(extractor).not.toHaveBeenCalled();
    const secondUpload = image();
    const secondGroup = await createUploadGroup(runtime, actor, venue, [secondUpload]);
    await acceptUploadGroupFile(
      runtime,
      actor,
      venue,
      secondGroup.id,
      0,
      secondUpload,
      async () => {},
    );
    const another = secondGroup.jobs[0]!;
    await admin.query(
      "UPDATE app_private.menu_ingestion_jobs SET status='failed',finished_at=now(),error_code='old_timeout',error_details='synthetic timeout',attempt_count=3 WHERE id=$1",
      [another.id],
    );
    const command = crypto.randomUUID();
    const queued = await changeMenuJob(runtime, actor, venue, another.id, command, 'retry');
    expect(queued.max_attempts).toBe(6);
    expect(
      (await changeMenuJob(runtime, actor, venue, another.id, command, 'retry')).max_attempts,
    ).toBe(6);
    const next = await claimIngestionJob(runtime, {
      tenantId: venue,
      jobId: another.id,
      workerId: 'fixture',
    });
    await persistExtractedDrafts(runtime, {
      tenantId: venue,
      jobId: another.id,
      claimToken: next!.claimToken,
      drafts: [],
    });
    const complete = await getIngestionJob(runtime, venue, another.id);
    expect(complete?.error_code).toBeNull();
    expect(complete?.error_details).toBeNull();
  });
  it('acknowledges archived incomplete work without silently restarting extraction', async () => {
    const upload = image();
    const group = await createUploadGroup(runtime, actor, venue, [upload]);
    await acceptUploadGroupFile(runtime, actor, venue, group.id, 0, upload, async () => {});
    const job = group.jobs[0]!;
    await admin.query(
      "UPDATE app_private.menu_ingestion_jobs SET status='incomplete',finished_at=now(),result_storage_key='synthetic-report' WHERE id=$1",
      [job.id],
    );
    expect(
      await claimIngestionJob(runtime, { tenantId: venue, jobId: job.id, workerId: 'duplicate' }),
    ).toBeNull();
    const ack = vi.fn();
    const retry = vi.fn();
    const extractor = vi.fn();
    await processIngestionQueueBatch(
      runtime,
      {
        messages: [
          {
            body: {
              version: 1,
              tenantId: venue,
              jobId: job.id,
              queuedAt: new Date().toISOString(),
            },
            ack,
            retry,
          },
        ],
      },
      extractor,
      { reportStorage: { put: vi.fn(), get: vi.fn(async () => '{"synthetic":true}') } },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(extractor).not.toHaveBeenCalled();
  });
  it('dispatches an uploaded sibling when a missing file is cancelled and repairs a failed dispatch', async () => {
    const uploads = [image(), image()];
    const group = await createUploadGroup(runtime, actor, venue, uploads);
    await acceptUploadGroupFile(runtime, actor, venue, group.id, 0, uploads[0]!, async () => {});
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic Queue unavailable'))
      .mockResolvedValue(undefined);
    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const env = { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl!, INGESTION_QUEUE: { send } };
    const commandId = crypto.randomUUID();
    const request = () =>
      app.request(
        `https://test/venues/${venue}/menus/jobs/${group.jobs[1]!.id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId }),
        },
        env,
      );
    expect((await request()).status).toBe(503);
    expect((await request()).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => (call[0] as { jobId: string }).jobId)).toEqual([
      group.jobs[0]!.id,
      group.jobs[0]!.id,
    ]);
  });
  it('persists URL provenance without changing first retrieval evidence on identical retries', async () => {
    const upload = {
      ...image(),
      provenance: {
        originalUrl: 'https://restaurant.example/menu',
        finalUrl: 'https://cdn.example/menu.png',
        retrievedAt: '2026-11-12T00:00:00.000Z',
      },
    };
    const group = await createUploadGroup(runtime, actor, venue, [upload]);
    expect(group.jobs[0]?.source_url).toBe(upload.provenance.finalUrl);
    expect(group.jobs[0]?.source_provenance).toEqual(upload.provenance);
    const again = await createUploadGroup(runtime, actor, venue, [
      { ...upload, provenance: { ...upload.provenance, retrievedAt: '2026-11-12T00:01:00.000Z' } },
    ]);
    expect(again.jobs[0]?.id).toBe(group.jobs[0]?.id);
    expect(again.jobs[0]?.source_provenance).toEqual(upload.provenance);
  });
  it('cancels the whole group atomically without dispatching uploaded siblings', async () => {
    const uploads = [image(), image()];
    const group = await createUploadGroup(runtime, actor, venue, uploads);
    await acceptUploadGroupFile(runtime, actor, venue, group.id, 0, uploads[0]!, async () => {});
    const send = vi.fn();
    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const commandId = crypto.randomUUID();
    const request = () =>
      app.request(
        `https://test/venues/${venue}/menus/upload-groups/${group.id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId }),
        },
        { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl!, INGESTION_QUEUE: { send } },
      );
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    const jobs = await admin.query(
      'SELECT status,lease_generation::text FROM app_private.menu_ingestion_jobs WHERE tenant_id=$1 AND upload_group_id=$2',
      [venue, group.id],
    );
    expect(jobs.rows).toEqual([
      { status: 'cancelled', lease_generation: '1' },
      { status: 'cancelled', lease_generation: '1' },
    ]);
  });
  it('exposes console CORS without weakening anonymous/venue checks or permitting arbitrary origins', async () => {
    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const url = `https://test/venues/${venue}/drafts/${crypto.randomUUID()}`;
    const env = { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl! };
    const preflight = await app.request(
      url,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://127.0.0.1:5174',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      },
      env,
    );
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5174');
    const forbidden = await app.request(
      url,
      {
        method: 'OPTIONS',
        headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'PUT' },
      },
      env,
    );
    expect(forbidden.headers.get('access-control-allow-origin')).toBeNull();
    expect((await app.request(url, {}, env)).status).toBe(401);
  });
  it('bootstraps private extraction review, accepts the current owner correction and freezes its facts', async () => {
    const bundle = JSON.parse(
      readFileSync(
        new URL(
          '../../processing/tests/fixtures/service-artifacts/representative-bundle.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const report = structuredClone(bundle.report);
    const sourceBytes = Uint8Array.from(Buffer.from(report.source.snapshot_base64, 'base64'));
    const upload = {
      bytes: sourceBytes,
      sourceType: 'pdf' as const,
      sourceHash: report.source.sha256,
      idempotencyKey: crypto.randomUUID(),
    };
    const group = await createUploadGroup(runtime, actor, venue, [upload]);
    const job = group.jobs[0]!;
    await acceptUploadGroupFile(runtime, actor, venue, group.id, 0, upload, async () => {});
    const attempt = crypto.randomUUID();
    const key = `menu-ingestion/review-artifacts/${venue}/${job.id}/${attempt}/bundle.json`;
    const stored = JSON.stringify({
      ...bundle,
      scope: {
        tenant_id: venue,
        job_id: job.id,
        source_hash: upload.sourceHash,
        attempt_id: attempt,
      },
    });
    report.configuration.private_review_artifact = {
      schema_version: 1,
      key,
      sha256: createHash('sha256').update(stored).digest('hex'),
    };
    const objects = new Map<string, string>([[key, stored]]);
    await processIngestionQueueBatch(
      runtime,
      {
        messages: [
          {
            body: {
              version: 1,
              tenantId: venue,
              jobId: job.id,
              queuedAt: new Date().toISOString(),
            },
            ack: vi.fn(),
            retry: vi.fn(),
          },
        ],
      },
      async () => report,
      {
        reportStorage: {
          put: async (k, value) => {
            objects.set(k, value);
          },
          get: async (k) => objects.get(k) ?? null,
        },
      },
    );
    const get = vi.fn(async (k: string) => {
      const value = objects.get(k);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return { size: bytes.length, arrayBuffer: async () => bytes.buffer };
    });
    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const env = {
      APP_ENV: 'local',
      LOCAL_DATABASE_URL: runtimeUrl!,
      INGESTION_REPORTS_BUCKET: { put: vi.fn(), get },
    };
    const commandId = crypto.randomUUID();
    const request = () =>
      app.request(
        `https://test/venues/${venue}/menus/jobs/${job.id}/review-session`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId }),
        },
        env,
      );
    const response = await request();
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      extractionResult: { extraction_id: string };
      items: { candidate: { candidate_id: string }; review: { version: number } }[];
    };
    expect(session.items).toHaveLength(report.drafts.length);
    expect(JSON.stringify(session)).not.toContain('snapshot_base64');
    expect(JSON.stringify(session)).not.toContain('review_suggestions');
    expect((await request()).status).toBe(200);
    const extractionId = session.extractionResult.extraction_id;
    const candidateId = session.items[0]!.candidate.candidate_id;
    let review = await saveCandidateReviewCommand(
      runtime,
      actor,
      venue,
      extractionId,
      candidateId,
      {
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        action: 'correct',
        corrected: {
          name: 'Owner verified fictional soup',
          price_amount: '9.00',
          category: 'Soups',
          ingredients: ['Carrot'],
        },
      },
    );
    let row = (
      await admin.query<{ id: string; draft_version: number }>(
        'SELECT id,draft_version FROM app_private.dish_drafts WHERE tenant_id=$1 AND job_id=$2 AND candidate_id=$3',
        [venue, job.id, candidateId],
      )
    ).rows[0]!;
    const verificationCommand = crypto.randomUUID();
    await verifyOwnerDish(
      runtime,
      actor,
      venue,
      row.id,
      verificationCommand,
      true,
      row.draft_version,
    );
    const oldVersion = row.draft_version;
    const removedInput = {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: oldVersion,
      expectedRemovalVersion: 0,
      removed: true,
    };
    await setDraftRemoval(runtime, actor, venue, row.id, removedInput);
    await expect(
      saveCandidateReviewCommand(runtime, actor, venue, extractionId, candidateId, {
        commandId: crypto.randomUUID(),
        expectedVersion: review.review.version,
        action: 'correct',
        corrected: { serving_size: 'A hidden edit' },
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await setDraftRemoval(runtime, actor, venue, row.id, {
      ...removedInput,
      commandId: crypto.randomUUID(),
      expectedRemovalVersion: 1,
      removed: false,
    });
    const servingCorrection = {
      commandId: crypto.randomUUID(),
      expectedVersion: review.review.version,
      action: 'correct' as const,
      corrected: { serving_count: 2 },
    };
    review = await saveCandidateReviewCommand(
      runtime,
      actor,
      venue,
      extractionId,
      candidateId,
      servingCorrection,
    );
    expect(review.effective.serving_count).toBe(2);
    expect(
      await saveCandidateReviewCommand(
        runtime,
        actor,
        venue,
        extractionId,
        candidateId,
        servingCorrection,
      ),
    ).toEqual(review);
    expect(
      (
        await admin.query(
          'SELECT draft_version,verification_status FROM app_private.dish_drafts WHERE id=$1',
          [row.id],
        )
      ).rows[0],
    ).toMatchObject({ draft_version: oldVersion + 1, verification_status: 'not_verified' });
    await expect(
      verifyOwnerDish(runtime, actor, venue, row.id, verificationCommand, true, oldVersion),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const photo = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      row.id,
      image(),
      'image/png',
      async () => {},
    );
    const foreignId = crypto.randomUUID();
    await save(foreignId);
    const foreignPhoto = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      foreignId,
      image(),
      'image/png',
      async () => {},
    );
    await expect(
      saveCandidateReviewCommand(runtime, actor, venue, extractionId, candidateId, {
        commandId: crypto.randomUUID(),
        expectedVersion: review.review.version,
        action: 'correct',
        corrected: { photo_id: foreignPhoto.id },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const portionCalibration: PlateCalibration = {
      shape: 'round',
      width_mm: 280,
      depth_mm: 280,
      source_sha256: photo.source_hash,
      source_width_px: 800,
      source_height_px: 600,
      boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      confirmed: true,
    };
    review = await saveCandidateReviewCommand(runtime, actor, venue, extractionId, candidateId, {
      commandId: crypto.randomUUID(),
      expectedVersion: review.review.version,
      action: 'correct',
      corrected: {
        serving_size: '2',
        portion_calibration: portionCalibration,
        photo_id: photo.id,
        allergens: { status: 'confirmed', items: ['milk'] },
      },
    });
    expect(review.effective).toMatchObject({
      serving_size: '2',
      serving_count: 2,
      portion_calibration: portionCalibration,
      photo_id: photo.id,
      allergens: { status: 'confirmed', items: ['milk'] },
    });
    const previewRecord = {
      status: 'failed',
      photo_sha256: photo.source_hash,
      dish_id: row.id,
      draft_revision_id: photo.id,
    };
    const previewBytes = new TextEncoder().encode(JSON.stringify(previewRecord));
    const recordKey = `${previewKey(venue, row.id, photo.id, photo.source_hash)}/record.json`;
    const preview = await app.request(
      `https://test/venues/${venue}/drafts/${row.id}/photos/${photo.id}/portion`,
      { headers: { Authorization: 'Bearer synthetic' } },
      {
        ...env,
        INGESTION_REPORTS_BUCKET: {
          ...env.INGESTION_REPORTS_BUCKET,
          get: async (key: string) =>
            key === recordKey
              ? { size: previewBytes.byteLength, arrayBuffer: async () => previewBytes.buffer }
              : null,
        },
      },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ portionReview: previewRecord });
    const changed = (
      await admin.query(
        'SELECT id,draft_version,verification_status FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2',
        [venue, row.id],
      )
    ).rows[0];
    expect(changed.draft_version).toBe(oldVersion + 2);
    expect(changed.verification_status).toBe('not_verified');
    row = changed;
    await verifyOwnerDish(
      runtime,
      actor,
      venue,
      row.id,
      crypto.randomUUID(),
      true,
      row.draft_version,
    );
    const reportKey = (
      await admin.query(
        'SELECT result_storage_key FROM app_private.menu_ingestion_jobs WHERE id=$1',
        [job.id],
      )
    ).rows[0].result_storage_key;
    await admin.query(
      'UPDATE app_private.menu_ingestion_jobs SET result_storage_key=$2 WHERE id=$1',
      [job.id, `reports/${venue}/${job.id}/attempts/${crypto.randomUUID()}/extraction.json`],
    );
    await expect(
      approveDishDraftAtomic(runtime, actor, venue, row.id, {
        commandId: crypto.randomUUID(),
        expectedDraftVersion: row.draft_version,
        expectedReviewVersion: review.review.version,
        extractionId,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'draft_confirmation_required' });
    await admin.query(
      'UPDATE app_private.menu_ingestion_jobs SET result_storage_key=$2 WHERE id=$1',
      [job.id, reportKey],
    );
    await expect(
      approveDishDraftAtomic(runtime, actor, venue, row.id, { commandId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'draft_confirmation_required' });
    await expect(
      approveDishDraftAtomic(runtime, actor, venue, row.id, {
        commandId: crypto.randomUUID(),
        expectedDraftVersion: row.draft_version,
        expectedReviewVersion: 0,
        extractionId,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'draft_confirmation_required' });
    const approved = await approveDishDraftAtomic(runtime, actor, venue, row.id, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: row.draft_version,
      expectedReviewVersion: review.review.version,
      extractionId,
      confirmed: true,
    });
    expect(approved.publishedRevision.name).toBe('Owner verified fictional soup');
    expect(approved.publishedRevision.facts?.priceAmount).toBe('9.00');
    expect(approved.publishedRevision.facts?.photoId).toBe(photo.id);
    expect(approved.publishedRevision.facts?.allergens).toEqual(['milk']);
    expect(approved.publishedRevision.facts?.portionCalibration).toEqual(portionCalibration);
    expect(approved.publishedRevision.facts?.servingSize).toBe('2');
    expect(approved.publishedRevision.facts?.servingCount).toBe(2);
    await saveCandidateReviewCommand(runtime, actor, venue, extractionId, candidateId, {
      commandId: crypto.randomUUID(),
      expectedVersion: review.review.version,
      action: 'correct',
      corrected: { price_amount: '99.00' },
    });
    expect(
      (await loadApprovedDishSources(runtime, venue, [approved.publishedRevision.dishId])).get(
        approved.publishedRevision.dishId,
      )?.priceAmount,
    ).toBe('9.00');
    const delayedGet = vi.fn(async (k: string) => {
      const value = await get(k);
      if (k === key)
        await admin.query(
          "UPDATE app_private.menu_ingestion_jobs SET status='queued' WHERE id=$1",
          [job.id],
        );
      return value;
    });
    const raced = await app.request(
      `https://test/venues/${venue}/menus/jobs/${job.id}/review-session`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: crypto.randomUUID() }),
      },
      { ...env, INGESTION_REPORTS_BUCKET: { put: vi.fn(), get: delayedGet } },
    );
    expect(raced.status).toBe(409);
    await admin.query("UPDATE app_private.menu_ingestion_jobs SET status='complete' WHERE id=$1", [
      job.id,
    ]);
    objects.set(key, stored + ' ');
    expect((await request()).status).toBe(409);
  });

  it('verifies extracted revisions with replay and clears verification on extraction retry', async () => {
    const report = JSON.parse(
      readFileSync(
        new URL(
          '../../processing/tests/fixtures/service-artifacts/representative-bundle.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).report;
    const adapted = adaptPythonExtractionResult(report);
    if (!adapted.success || !adapted.drafts.length) throw new Error('invalid_review_fixture');
    const upload = image();
    const group = await createUploadGroup(runtime, actor, venue, [upload]);
    await acceptUploadGroupFile(runtime, actor, venue, group.id, 0, upload, async () => {});
    const job = group.jobs[0]!;
    const persist = async () => {
      const claim = await claimIngestionJob(runtime, {
        tenantId: venue,
        jobId: job.id,
        workerId: 'verification-review',
      });
      await persistExtractedDrafts(runtime, {
        tenantId: venue,
        jobId: job.id,
        claimToken: claim!.claimToken,
        drafts: adapted.drafts,
      });
    };
    await persist();
    const row = (
      await admin.query(
        'SELECT id,draft_version FROM app_private.dish_drafts WHERE tenant_id=$1 AND job_id=$2 ORDER BY draft_index LIMIT 1',
        [venue, job.id],
      )
    ).rows[0];
    const command = crypto.randomUUID();
    await verifyOwnerDish(runtime, actor, venue, row.id, command, true, 1);
    await expect(
      verifyOwnerDish(runtime, actor, other, row.id, crypto.randomUUID(), true, 1),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      verifyOwnerDish(runtime, viewer, venue, row.id, crypto.randomUUID(), true, 1),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await admin.query(
      "UPDATE app_private.menu_ingestion_jobs SET status='failed',finished_at=now() WHERE id=$1",
      [job.id],
    );
    await changeMenuJob(runtime, actor, venue, job.id, crypto.randomUUID(), 'retry');
    await persist();
    const refreshed = (
      await admin.query(
        'SELECT draft_version,verification_status FROM app_private.dish_drafts WHERE id=$1',
        [row.id],
      )
    ).rows[0];
    expect(refreshed).toEqual({ draft_version: 2, verification_status: 'not_verified' });
    const events = (
      await admin.query(
        "SELECT version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_type='owner_draft_verification' AND stream_id=$2 ORDER BY version",
        [venue, row.id],
      )
    ).rows;
    expect(events).toHaveLength(1);
    expect(replayOwnerDraftVerification(events, 1)).toBe('verified');
    expect(replayOwnerDraftVerification(events, 2)).toBe('not_verified');
    await expect(
      verifyOwnerDish(runtime, actor, venue, row.id, command, true, 1),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(
      (
        await admin.query('SELECT verification_status FROM app_private.dish_drafts WHERE id=$1', [
          row.id,
        ])
      ).rows[0].verification_status,
    ).toBe('not_verified');
    await verifyOwnerDish(runtime, actor, venue, row.id, crypto.randomUUID(), true, 2);
    const reverified = (
      await admin.query(
        "SELECT version,schema_version,event_type,payload FROM app_private.es_event WHERE tenant_id=$1 AND stream_type='owner_draft_verification' AND stream_id=$2 ORDER BY version",
        [venue, row.id],
      )
    ).rows;
    expect(reverified.map((event) => event.version)).toEqual([1, 2]);
    expect(replayOwnerDraftVerification(reverified, 2)).toBe('verified');
    expect(
      (
        await admin.query('SELECT verification_status FROM app_private.dish_drafts WHERE id=$1', [
          row.id,
        ])
      ).rows[0].verification_status,
    ).toBe('verified');
  });

  it('retention scopes restricted reads and distinguishes pending and orphaned portion files', async () => {
    const draftId = crypto.randomUUID();
    await save(draftId);
    const photo = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      image(),
      'image/png',
      async () => {},
    );
    const pending = `${previewKey(venue, draftId, photo.id, photo.source_hash)}/record.json`;
    const orphan = `${previewKey(venue, draftId, crypto.randomUUID(), photo.source_hash)}/record.json`;
    const storage = {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [photo.storage_key, pending, orphan]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, uploaded: new Date(0) })),
      }),
      get: async () => null,
      put: async () => {},
      delete: vi.fn(async () => {}),
    };
    const result = await cleanupStagedMenuPhotos({
      storage,
      client: runtime,
      retentionConfig: { orphanGraceDays: 1 },
    });
    expect(result.protectedPending).toBe(2);
    expect(result.orphansDeleted).toBe(1);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(orphan);
    expect(
      (await runtime.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0]
        .tenant,
    ).toBe('');
  });

  it('HTTP verification requires authority and reviewed version before accepting the draft', async () => {
    const id = crypto.randomUUID();
    await save(id);
    const app = createApp({ verify: async () => actor, execute: vi.fn() });
    const env = { APP_ENV: 'local', LOCAL_DATABASE_URL: runtimeUrl! };
    const request = (body: unknown, venueId = venue, authenticated = true) =>
      app.request(
        `https://test/venues/${venueId}/drafts/${id}/verify`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authenticated ? { Authorization: 'Bearer synthetic' } : {}),
          },
          body: JSON.stringify(body),
        },
        env,
      );
    expect(
      (await request({ commandId: crypto.randomUUID(), expectedVersion: 1 }, venue, false)).status,
    ).toBe(401);
    expect((await request({ commandId: crypto.randomUUID() })).status).toBe(400);
    expect(
      (await request({ commandId: crypto.randomUUID(), expectedVersion: 1 }, other)).status,
    ).toBe(403);
    expect((await request({ commandId: crypto.randomUUID(), expectedVersion: 2 })).status).toBe(
      409,
    );
    const success = await request({ commandId: crypto.randomUUID(), expectedVersion: 1 });
    expect(success.status).toBe(200);
    expect(
      ((await success.json()) as { draft: { verification_status: string } }).draft
        .verification_status,
    ).toBe('verified');
  });

  it('dish verification rejects stale content and is invalidated by a later edit', async () => {
    const id = crypto.randomUUID();
    await save(id);
    await save(id, { name: 'Updated soup' }, 1);
    await expect(
      verifyOwnerDish(runtime, actor, venue, id, crypto.randomUUID(), true, 1),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const verified = await verifyOwnerDish(runtime, actor, venue, id, crypto.randomUUID(), true, 2);
    expect(verified.draft.draft_version).toBe(2);
    expect(verified.draft.verification_status).toBe('verified');
    expect((await save(id, { name: 'Changed again' }, 2)).verification_status).toBe('not_verified');
  });

  it('photo approval and rejection serialize successive commands and replay without storage effects', async () => {
    const draftId = crypto.randomUUID();
    await save(draftId);
    const bytes = image();
    const storage = {
      get: vi.fn(async () => ({ arrayBuffer: async () => bytes.bytes.buffer as ArrayBuffer })),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const photo = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      bytes,
      'image/png',
      storage.put,
    );
    const commandId = crypto.randomUUID();
    await promoteDraftPhoto(runtime, actor, venue, draftId, photo.id, commandId, storage);
    const readCount = storage.get.mock.calls.length;
    const replay = await promoteDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      photo.id,
      commandId,
      storage,
    );
    expect(replay.stagingKeyToDelete).toBeNull();
    expect(storage.get).toHaveBeenCalledTimes(readCount);
    await rejectDraftPhoto(runtime, actor, venue, draftId, photo.id, crypto.randomUUID());
    await promoteDraftPhoto(runtime, actor, venue, draftId, photo.id, crypto.randomUUID(), storage);
    const events = await admin.query(
      "SELECT version FROM app_private.es_event WHERE tenant_id=$1 AND stream_type='owner_photo' AND stream_id=$2 ORDER BY version",
      [venue, photo.id],
    );
    expect(events.rows.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it('promotes staged photos to menu-assets safely and decouples from dish verification', async () => {
    const draftId = crypto.randomUUID();
    await save(draftId);

    const storageObjects = new Map<string, ArrayBuffer>();
    const storage = {
      get: vi.fn(async (key: string) => {
        const buf = storageObjects.get(key);
        if (!buf) return null;
        return {
          arrayBuffer: async () => buf.slice(0),
          size: buf.byteLength,
        };
      }),
      put: vi.fn(async (key: string, bytes: ArrayBuffer) => {
        storageObjects.set(key, bytes.slice(0));
      }),
      delete: vi.fn(async (key: string) => {
        storageObjects.delete(key);
      }),
    };

    const img = image();
    const photo = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      img,
      'image/png',
      storage.put,
    );
    expect(photo.storage_key).toBe(`menu-staging/${venue}/${draftId}/${img.sourceHash}`);
    expect(storageObjects.has(photo.storage_key)).toBe(true);

    // 1. Promote photo
    const commandId = crypto.randomUUID();
    const promoted = await promoteDraftPhoto(
      runtime,
      actor,
      venue,
      draftId,
      photo.id,
      commandId,
      storage,
    );
    expect(promoted.photo.verification_status).toBe('verified');
    expect(promoted.photo.storage_key).toBe(`menu-assets/${venue}/${photo.id}/${img.sourceHash}`);
    expect(promoted.stagingKeyToDelete).toBe(`menu-staging/${venue}/${draftId}/${img.sourceHash}`);

    // Verify destination in storage
    expect(storageObjects.has(promoted.photo.storage_key)).toBe(true);
    // Delete staging after commit
    if (promoted.stagingKeyToDelete) {
      await storage.delete(promoted.stagingKeyToDelete);
    }
    expect(storageObjects.has(`menu-staging/${venue}/${draftId}/${img.sourceHash}`)).toBe(false);

    // Verify draft verification_status is still not_verified (decoupled!)
    const draftAfterPhoto = (
      await admin.query('SELECT verification_status FROM app_private.dish_drafts WHERE id=$1', [
        draftId,
      ])
    ).rows[0];
    expect(draftAfterPhoto.verification_status).toBe('not_verified');

    // 2. Verify dish independently
    const verifyCmd = crypto.randomUUID();
    const verifiedDish = await verifyOwnerDish(runtime, actor, venue, draftId, verifyCmd, true, 1);
    expect(verifiedDish.draft.verification_status).toBe('verified');

    // Replay projection check
    const events = await admin.query<{
      version: number;
      schema_version: number;
      event_type: string;
      payload: unknown;
    }>(
      `SELECT version, schema_version, event_type, payload
       FROM app_private.es_event
       WHERE tenant_id=$1 AND stream_type='owner_draft_verification' AND stream_id=$2
       ORDER BY version ASC`,
      [venue, draftId],
    );
    expect(replayOwnerDraftVerification(events.rows, 1)).toBe('verified');
    expect(replayOwnerDraftVerification(events.rows, 2)).toBe('not_verified');

    // 3. Reject photo on a new draft
    const draft2Id = crypto.randomUUID();
    await save(draft2Id);
    const img2 = image();
    const photo2 = await storeDraftPhoto(
      runtime,
      actor,
      venue,
      draft2Id,
      img2,
      'image/png',
      storage.put,
    );
    const rejectCmd = crypto.randomUUID();
    const rejected = await rejectDraftPhoto(runtime, actor, venue, draft2Id, photo2.id, rejectCmd);
    expect(rejected.photo.verification_status).toBe('rejected');
    // Staging file preserved
    expect(storageObjects.has(photo2.storage_key)).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import { OwnerDishFieldsSchema } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApprovedDishSources } from './bundle-producer/repository';
import { createDishRevision, replayDish } from './dish-command';
import { approveDishDraftAtomic, createApp } from './index';
import {
  acceptUploadGroupFile,
  changeMenuJob,
  createUploadGroup,
  dispatchReadyUploadGroup,
} from './ingestion/intake';
import { processIngestionQueueBatch } from './ingestion/orchestrator';
import { claimIngestionJob, getIngestionJob, persistExtractedDrafts } from './ingestion/repository';
import { replayOwnerDraft, saveOwnerDishDraft, storeDraftPhoto } from './owner-menu';

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
    expect(put.mock.calls[0]?.[0]).toBe(`owner-draft-photos/${venue}/${id}/${image().sourceHash}`);
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
    expect(
      (await loadApprovedDishSources(runtime, venue, [result.publishedRevision.dishId])).get(
        result.publishedRevision.dishId,
      )?.reviewState,
    ).toBe('incomplete');
    await expect(save(id, { name: 'Changed' }, 1)).rejects.toMatchObject({
      code: 'draft_not_editable',
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
    await expect(
      storeDraftPhoto(runtime, actor, venue, id, image(), 'image/png', put),
    ).rejects.toMatchObject({ code: 'draft_not_editable' });
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
    expect(source?.reviewState).toBe('incomplete');
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
});

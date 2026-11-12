import { createHash } from 'node:crypto';
import {
  CreateMenuUploadGroupSchema,
  DraftPhotoScopeSchema,
  DraftScopeSchema,
  JobScopeSchema,
  MenuJobActionSchema,
  MenuUploadGroupScopeSchema,
  MenuUrlIntakeSchema,
  SaveOwnerDishDraftSchema,
  VenueScopeSchema,
} from '@peekaplate/contracts';
import type { Context, Hono } from 'hono';
import type { Client } from 'pg';
import { AuthUnavailableError } from './auth';
import type { Bindings } from './index';
import {
  acceptUploadGroupFile,
  cancelUploadGroup,
  changeMenuJob,
  createUploadGroup,
  dispatchReadyUploadGroup,
  materializeMenuUrl,
  readUploadGroup,
  validateMenuPdf,
} from './ingestion/intake';
import { type DishDraftRow, IngestionError } from './ingestion/repository';
import { bootstrapMenuReview } from './ingestion/review-bootstrap';
import { readMenuUpload } from './ingestion/upload';
import {
  type DraftPhoto,
  saveOwnerDishDraft,
  storeDraftPhoto,
  withOwnerMenuTransaction,
} from './owner-menu';

type Services = {
  verify(authorization: string, env: Bindings): Promise<string>;
  authorizeVenue(actor: string, venue: string, env: Bindings): Promise<void>;
  database<T>(env: Bindings, work: (client: Client) => Promise<T>): Promise<T>;
};
export function registerOwnerMenuRoutes(app: Hono<{ Bindings: Bindings }>, services: Services) {
  const identity = async (c: Context<{ Bindings: Bindings }>) => {
    if (!['staging', 'local'].includes(c.env?.APP_ENV ?? ''))
      throw new IngestionError('not_found', 404);
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      throw new IngestionError('unauthorized', 401);
    const actor = await services.verify(authorization, c.env);
    const scope = VenueScopeSchema.safeParse({ venueId: c.req.param('venueId') });
    if (!scope.success) throw new IngestionError('invalid_request', 400);
    await services.authorizeVenue(actor, scope.data.venueId, c.env);
    return { actor, venue: scope.data.venueId.toLowerCase() };
  };
  const json = async (c: Context<{ Bindings: Bindings }>) => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? ''))
      throw new IngestionError('unsupported_media_type', 415);
    try {
      return await c.req.json();
    } catch {
      throw new IngestionError('invalid_json', 400);
    }
  };

  app.put('/venues/:venueId/drafts/:draftId', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftScopeSchema.safeParse(c.req.param());
    const input = SaveOwnerDishDraftSchema.safeParse(await json(c));
    if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
    const draft = await services.database(c.env, (client) =>
      saveOwnerDishDraft(client, actor, venue, scope.data.draftId, input.data),
    );
    return c.json({ draft });
  });
  app.get('/venues/:venueId/drafts/:draftId', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    const draft = await services.database(c.env, (client) =>
      withOwnerMenuTransaction(client, actor, venue, async () => {
        const result = await client.query<DishDraftRow>(
          'SELECT * FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2',
          [venue, scope.data.draftId],
        );
        return result.rows[0];
      }),
    );
    return draft ? c.json({ draft }) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/venues/:venueId/drafts/:draftId/photos', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    const type = c.req.header('Content-Type')?.split(';')[0]?.trim();
    if (!['image/jpeg', 'image/png'].includes(type ?? ''))
      return c.json({ error: 'unsupported_media_type' }, 415);
    const bucket = c.env.INGESTION_REPORTS_BUCKET;
    if (!bucket) throw new AuthUnavailableError();
    const upload = await readMenuUpload(c.req.raw);
    const photo = await services.database(c.env, (client) =>
      storeDraftPhoto(client, actor, venue, scope.data.draftId, upload, type!, (key, bytes) =>
        bucket.put(key, bytes),
      ),
    );
    return c.json(
      {
        photo: {
          id: photo.id,
          draftId: photo.draft_id,
          contentType: photo.content_type,
          sizeBytes: photo.size_bytes,
          sha256: photo.source_hash,
        },
      },
      201,
    );
  });
  app.get('/venues/:venueId/drafts/:draftId/photos/:photoId', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftPhotoScopeSchema.safeParse(c.req.param());
    const photoId = c.req.param('photoId');
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    const photo = await services.database(c.env, (client) =>
      withOwnerMenuTransaction(client, actor, venue, async () => {
        const result = await client.query<DraftPhoto>(
          'SELECT * FROM app_private.dish_draft_photo WHERE tenant_id=$1 AND draft_id=$2 AND id=$3',
          [venue, scope.data.draftId, photoId],
        );
        return result.rows[0];
      }),
    );
    if (!photo) return c.json({ error: 'not_found' }, 404);
    const read = c.env.INGESTION_REPORTS_BUCKET?.get;
    if (!read) throw new AuthUnavailableError();
    const object = await read.call(c.env.INGESTION_REPORTS_BUCKET, photo.storage_key);
    if (!object || object.size !== photo.size_bytes) throw new AuthUnavailableError();
    c.header('Content-Type', photo.content_type);
    c.header('X-Content-Type-Options', 'nosniff');
    const bytes = await object.arrayBuffer();
    if (
      bytes.byteLength !== photo.size_bytes ||
      createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== photo.source_hash
    )
      throw new AuthUnavailableError();
    return c.body(bytes);
  });
  app.post('/venues/:venueId/menus/upload-groups', async (c) => {
    const { actor, venue } = await identity(c);
    const input = CreateMenuUploadGroupSchema.safeParse(await json(c));
    if (!input.success) return c.json({ error: 'invalid_request' }, 400);
    const uploads = input.data.files.map((file) => ({
      ...file,
      idempotencyKey: input.data.idempotencyKey,
    }));
    const group = await services.database(c.env, (client) =>
      createUploadGroup(client, actor, venue, uploads),
    );
    return c.json({ group }, 202);
  });
  app.put('/venues/:venueId/menus/upload-groups/:groupId/files/:index', async (c) => {
    const { actor, venue } = await identity(c);
    const groupId = c.req.param('groupId');
    const index = c.req.param('index');
    if (
      !MenuUploadGroupScopeSchema.safeParse({ venueId: venue, groupId }).success ||
      !/^[0-4]$/.test(index)
    )
      return c.json({ error: 'invalid_request' }, 400);
    const storage = c.env.INGESTION_REPORTS_BUCKET;
    const queue = c.env.INGESTION_QUEUE;
    if (!storage || !queue) throw new AuthUnavailableError();
    const upload = await readMenuUpload(c.req.raw);
    await validateMenuPdf(upload);
    const group = await services.database(c.env, (client) =>
      acceptUploadGroupFile(client, actor, venue, groupId, Number(index), upload, (key, bytes) =>
        storage.put(key, bytes),
      ),
    );
    await dispatchReadyUploadGroup(group, queue);
    return c.json({ group }, 202);
  });
  app.post('/venues/:venueId/menus/url', async (c) => {
    const { actor, venue } = await identity(c);
    const input = MenuUrlIntakeSchema.safeParse(await json(c));
    if (!input.success) return c.json({ error: 'invalid_request' }, 400);
    const storage = c.env.INGESTION_REPORTS_BUCKET;
    const queue = c.env.INGESTION_QUEUE;
    if (!storage || !queue) throw new AuthUnavailableError();
    const upload = await materializeMenuUrl(input.data.url, input.data.idempotencyKey);
    const group = await services.database(c.env, (client) =>
      createUploadGroup(client, actor, venue, [upload]),
    );
    const ready = await services.database(c.env, (client) =>
      acceptUploadGroupFile(client, actor, venue, group.id, 0, upload, (key, bytes) =>
        storage.put(key, bytes),
      ),
    );
    await dispatchReadyUploadGroup(ready, queue);
    return c.json({ group: ready }, 202);
  });
  app.get('/venues/:venueId/menus/jobs', async (c) => {
    const { actor, venue } = await identity(c);
    const groupId = c.req.query('groupId');
    if (groupId && !MenuUploadGroupScopeSchema.safeParse({ venueId: venue, groupId }).success)
      return c.json({ error: 'invalid_request' }, 400);
    const jobs = await services.database(c.env, (client) =>
      withOwnerMenuTransaction(client, actor, venue, async () => {
        const result = await client.query(
          `SELECT * FROM app_private.menu_ingestion_jobs WHERE tenant_id=$1 AND ($2::uuid IS NULL OR upload_group_id=$2) ORDER BY created_at DESC, upload_index ASC NULLS LAST, id LIMIT 100`,
          [venue, groupId ?? null],
        );
        return result.rows;
      }),
    );
    return c.json({ jobs });
  });
  app.post('/venues/:venueId/menus/upload-groups/:groupId/cancel', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = MenuUploadGroupScopeSchema.safeParse(c.req.param());
    const input = MenuJobActionSchema.safeParse(await json(c));
    if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
    const group = await services.database(c.env, (client) =>
      cancelUploadGroup(client, actor, venue, scope.data.groupId, input.data.commandId),
    );
    return c.json({ group });
  });
  app.post('/venues/:venueId/menus/jobs/:jobId/review-session', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = JobScopeSchema.safeParse(c.req.param());
    const input = MenuJobActionSchema.safeParse(await json(c));
    if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
    const bucket = c.env.INGESTION_REPORTS_BUCKET;
    if (!bucket?.get) throw new AuthUnavailableError();
    const read = (key: string) => bucket.get!.call(bucket, key);
    const session = await services.database(c.env, (client) =>
      bootstrapMenuReview(
        client,
        actor,
        venue,
        scope.data.jobId.toLowerCase(),
        input.data.commandId,
        read,
        c.env.APP_ENV,
      ),
    );
    return c.json(session);
  });
  for (const action of ['cancel', 'retry'] as const) {
    app.post(`/venues/:venueId/menus/jobs/:jobId/${action}`, async (c) => {
      const { actor, venue } = await identity(c);
      const scope = JobScopeSchema.safeParse(c.req.param());
      const input = MenuJobActionSchema.safeParse(await json(c));
      if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
      const job = await services.database(c.env, (client) =>
        changeMenuJob(client, actor, venue, scope.data.jobId, input.data.commandId, action),
      );
      if (job.upload_group_id) {
        const group = await services.database(c.env, (client) =>
          readUploadGroup(client, actor, venue, job.upload_group_id!),
        );
        if (
          group.ready &&
          group.jobs.some((member) => member.status === 'queued' && member.source_uploaded)
        ) {
          if (!c.env.INGESTION_QUEUE) throw new AuthUnavailableError();
          await dispatchReadyUploadGroup(group, c.env.INGESTION_QUEUE);
        }
      } else if (action === 'retry' && job.status === 'queued') {
        if (!c.env.INGESTION_QUEUE) throw new AuthUnavailableError();
        await c.env.INGESTION_QUEUE.send({
          version: 1,
          tenantId: venue,
          jobId: job.id,
          queuedAt: new Date().toISOString(),
        });
      }
      return c.json({ job });
    });
  }
}

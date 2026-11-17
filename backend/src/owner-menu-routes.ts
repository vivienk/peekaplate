import { createHash } from 'node:crypto';
import {
  ApproveDraftPhotoSchema,
  CreateMenuUploadGroupSchema,
  DraftPhotoScopeSchema,
  DraftScopeSchema,
  JobScopeSchema,
  MenuJobActionSchema,
  MenuUploadGroupScopeSchema,
  MenuUrlIntakeSchema,
  RejectDraftPhotoSchema,
  SaveOwnerDishDraftSchema,
  SaveRestaurantProfileSchema,
  SetDraftRemovalSchema,
  VenueScopeSchema,
  VerifyDishDraftSchema,
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
  promoteDraftPhoto,
  rejectDraftPhoto,
  saveOwnerDishDraft,
  setDraftRemoval,
  storeDraftPhoto,
  verifyOwnerDish,
  withOwnerMenuTransaction,
} from './owner-menu';
import {
  approvePrivatePortion,
  exportApprovedPrivatePortion,
  previewKey,
  privatePreviewImage,
  processPrivateDishPhoto,
  readPrivatePortion,
  readPrivatePortionApproval,
} from './owner-portion-preview';
import {
  readRestaurantProfile,
  readRestaurantSetup,
  restaurantPhoto,
  saveRestaurantProfile,
  storeRestaurantPhoto,
} from './restaurant-profile';

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

  app.get('/venues/:venueId/profile', async (c) => {
    const { actor, venue } = await identity(c);
    return c.json({
      profile: await services.database(c.env, (client) =>
        readRestaurantProfile(client, actor, venue),
      ),
    });
  });
  app.get('/venues/:venueId/setup', async (c) => {
    const { actor, venue } = await identity(c);
    return c.json(
      await services.database(c.env, (client) => readRestaurantSetup(client, actor, venue)),
    );
  });
  app.put('/venues/:venueId/profile', async (c) => {
    const { actor, venue } = await identity(c);
    const input = SaveRestaurantProfileSchema.safeParse(await json(c));
    if (!input.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json({
      profile: await services.database(c.env, (client) =>
        saveRestaurantProfile(client, actor, venue, input.data),
      ),
    });
  });
  app.post('/venues/:venueId/profile/photos', async (c) => {
    const { actor, venue } = await identity(c);
    const bucket = c.env.INGESTION_REPORTS_BUCKET;
    if (!bucket) throw new AuthUnavailableError();
    const type = c.req.header('Content-Type')?.split(';')[0]?.trim() ?? '';
    if (!['image/jpeg', 'image/png'].includes(type))
      return c.json({ error: 'unsupported_media_type' }, 415);
    const upload = await readMenuUpload(c.req.raw);
    return c.json(
      await services.database(c.env, (client) =>
        storeRestaurantPhoto(
          client,
          actor,
          venue,
          upload,
          type,
          (key, bytes) => bucket.put(key, bytes),
          async (key) => {
            const object = await bucket.get?.(key);
            return object ? object.arrayBuffer() : null;
          },
        ),
      ),
      201,
    );
  });
  app.get('/venues/:venueId/profile/photos/:photoId', async (c) => {
    const { actor, venue } = await identity(c);
    const photoId = c.req.param('photoId');
    if (!DraftPhotoScopeSchema.shape.photoId.safeParse(photoId).success)
      return c.json({ error: 'invalid_request' }, 400);
    const photo = await services.database(c.env, (client) =>
      restaurantPhoto(client, actor, venue, photoId),
    );
    const object = await c.env.INGESTION_REPORTS_BUCKET?.get?.(photo.storage_key);
    if (!object) throw new AuthUnavailableError();
    const bytes = await object.arrayBuffer();
    if (
      bytes.byteLength !== photo.size_bytes ||
      createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== photo.source_hash
    )
      throw new AuthUnavailableError();
    c.header('Content-Type', photo.content_type);
    c.header('Content-Length', String(photo.size_bytes));
    c.header('X-Content-SHA256', photo.source_hash);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, no-store');
    return c.body(bytes);
  });
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
  app.post('/venues/:venueId/drafts/:draftId/verify', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftScopeSchema.safeParse(c.req.param());
    const input = VerifyDishDraftSchema.safeParse(await json(c));
    if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
    const result = await services.database(c.env, (client) =>
      verifyOwnerDish(
        client,
        actor,
        venue,
        scope.data.draftId,
        input.data.commandId,
        input.data.verified,
        input.data.expectedVersion,
      ),
    );
    return c.json(result);
  });
  app.post('/venues/:venueId/drafts/:draftId/removal', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftScopeSchema.safeParse(c.req.param());
    const input = SetDraftRemovalSchema.safeParse(await json(c));
    if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json({
      draft: await services.database(c.env, (client) =>
        setDraftRemoval(client, actor, venue, scope.data.draftId, input.data),
      ),
    });
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
          verificationStatus: photo.verification_status ?? 'not_verified',
          storageKey: photo.storage_key,
        },
      },
      201,
    );
  });

  // S09 private 2.5D review. These routes do not approve/promote/publicly expose images.
  // A draft's active photo ID and the authenticated venue are checked for every operation.
  const portionScope = async (c: Context<{ Bindings: Bindings }>) => {
    const { actor, venue } = await identity(c);
    const scope = DraftPhotoScopeSchema.safeParse(c.req.param());
    if (!scope.success) throw new IngestionError('invalid_request', 400);
    const draftId = scope.data.draftId.toLowerCase();
    const photoId = scope.data.photoId.toLowerCase();
    const photo = await services.database(c.env, (client) =>
      withOwnerMenuTransaction(client, actor, venue, async () => {
        const row = await client.query<DraftPhoto>(
          `SELECT p.* FROM app_private.dish_draft_photo p
             JOIN app_private.dish_drafts d ON d.tenant_id=p.tenant_id
               AND d.id=p.draft_id
            WHERE p.tenant_id=$1 AND p.draft_id=$2 AND p.id=$3
              AND d.removed_at IS NULL
              AND p.verification_status<>'rejected'
              AND (
                lower(d.manual_fields->>'photoId')=p.id::text
                OR EXISTS (
                  SELECT 1 FROM app_private.extraction_review_session s
                  JOIN app_private.candidate_review_current review
                    ON review.tenant_id=s.tenant_id
                   AND review.extraction_id=s.extraction_id
                   AND review.candidate_id=d.candidate_id
                  WHERE s.tenant_id=d.tenant_id
                    AND s.job_id=d.job_id
                    AND lower(review.corrected_fields->>'photo_id')=p.id::text
                )
              )`,
          [venue, draftId, photoId],
        );
        return row.rows[0];
      }),
    );
    if (!photo) throw new IngestionError('photo_not_found', 404);
    const bucket = c.env.INGESTION_REPORTS_BUCKET;
    if (!bucket?.get) throw new AuthUnavailableError();
    return {
      actor,
      venue,
      draftId,
      photoId,
      photo,
      bucket,
      key: previewKey(venue, draftId, photoId, photo.source_hash),
    };
  };

  app.post('/venues/:venueId/drafts/:draftId/photos/:photoId/portion', async (c) => {
    const scope = await portionScope(c);
    try {
      const record = await processPrivateDishPhoto({
        env: c.env,
        bucket: scope.bucket,
        venueId: scope.venue,
        draftId: scope.draftId,
        photoId: scope.photoId,
        sourceKey: scope.photo.storage_key,
        sourceHash: scope.photo.source_hash,
        sourceSize: scope.photo.size_bytes,
      });
      const approval = await readPrivatePortionApproval(scope.bucket, scope.key, record);
      c.header('Cache-Control', 'no-store');
      return c.json({ portionReview: { ...record, approved: Boolean(approval) } });
    } catch {
      return c.json({ error: 'portion_processing_unavailable' }, 503);
    }
  });

  app.get('/venues/:venueId/drafts/:draftId/photos/:photoId/portion', async (c) => {
    const scope = await portionScope(c);
    const record = await readPrivatePortion(scope.bucket, scope.key);
    c.header('Cache-Control', 'no-store');
    return record ? c.json({ portionReview: record }) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/venues/:venueId/drafts/:draftId/photos/:photoId/portion/approve', async (c) => {
    const scope = await portionScope(c);
    try {
      const approval = await approvePrivatePortion(scope.bucket, scope.key, scope.actor);
      c.header('Cache-Control', 'no-store');
      return c.json({ approved: true, approvedAt: approval.approved_at });
    } catch {
      return c.json({ error: 'portion_not_ready' }, 409);
    }
  });

  // Export for the existing privileged operator's exact bundle preparation. This
  // never hosts an asset publicly or publishes a menu by itself.
  app.get('/venues/:venueId/drafts/:draftId/photos/:photoId/portion/export', async (c) => {
    const scope = await portionScope(c);
    if (scope.photo.verification_status !== 'verified') {
      return c.json({ error: 'photo_not_verified' }, 409);
    }
    const published = await services.database(c.env, (client) =>
      withOwnerMenuTransaction(client, scope.actor, scope.venue, async () => {
        const result = await client.query<{ dish_id: string; revision_id: string }>(
          `SELECT d.published_dish_id AS dish_id, current.revision_id
             FROM app_private.dish_drafts d
             JOIN app_private.dish_current current
               ON current.tenant_id=d.tenant_id
              AND current.dish_id=d.published_dish_id
            WHERE d.tenant_id=$1 AND d.id=$2
              AND d.review_status IN ('accepted','edited')
              AND d.removed_at IS NULL
              AND lower(current.approved_facts->>'photoId')=$3
              AND (
                lower(d.manual_fields->>'photoId')=$3
                OR EXISTS (
                  SELECT 1 FROM app_private.extraction_review_session s
                  JOIN app_private.candidate_review_current review
                    ON review.tenant_id=s.tenant_id
                   AND review.extraction_id=s.extraction_id
                   AND review.candidate_id=d.candidate_id
                  WHERE s.tenant_id=d.tenant_id
                    AND s.job_id=d.job_id
                    AND lower(review.corrected_fields->>'photo_id')=$3
                )
              )`,
          [scope.venue, scope.draftId, scope.photoId],
        );
        return result.rows[0];
      }),
    );
    if (!published) return c.json({ error: 'approved_dish_revision_unavailable' }, 409);
    try {
      const artifact = await exportApprovedPrivatePortion(scope.bucket, scope.key);
      c.header('Cache-Control', 'private, no-store');
      return c.json({
        ...artifact,
        venueId: scope.venue,
        dishId: published.dish_id,
        dishRevisionId: published.revision_id,
        publicationEligible: false,
      });
    } catch {
      return c.json({ error: 'portion_not_approved' }, 409);
    }
  });

  app.get('/venues/:venueId/drafts/:draftId/photos/:photoId/portion/image', async (c) => {
    const scope = await portionScope(c);
    const record = await readPrivatePortion(scope.bucket, scope.key);
    if (!record) return c.json({ error: 'not_found' }, 404);
    const image = await privatePreviewImage(scope.bucket, scope.key, record);
    if (!image) return c.json({ error: 'not_found' }, 404);
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(image.buffer as ArrayBuffer);
  });

  app.post('/venues/:venueId/drafts/:draftId/photos/:photoId/approve', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftPhotoScopeSchema.safeParse(c.req.param());
    const input = ApproveDraftPhotoSchema.safeParse(await json(c));
    if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
    const bucket = c.env.INGESTION_REPORTS_BUCKET;
    if (!bucket?.get || !bucket?.put) throw new AuthUnavailableError();
    const storage = {
      get: (key: string) => bucket.get!(key),
      put: (key: string, value: ArrayBuffer) => bucket.put(key, value),
      delete: (key: string) => (bucket.delete ? bucket.delete(key) : Promise.resolve()),
    };
    const { photo, stagingKeyToDelete } = await services.database(c.env, (client) =>
      promoteDraftPhoto(
        client,
        actor,
        venue,
        scope.data.draftId,
        scope.data.photoId,
        input.data.commandId,
        storage,
      ),
    );
    if (stagingKeyToDelete && bucket.delete) {
      try {
        await bucket.delete(stagingKeyToDelete);
      } catch {
        // Safe post-commit staging deletion: failure logged, retryable by scheduled retention
      }
    }
    return c.json({
      photo: {
        id: photo.id,
        draftId: photo.draft_id,
        contentType: photo.content_type,
        sizeBytes: photo.size_bytes,
        sha256: photo.source_hash,
        verificationStatus: photo.verification_status,
        storageKey: photo.storage_key,
        promotedStorageKey: photo.promoted_storage_key,
      },
    });
  });
  app.post('/venues/:venueId/drafts/:draftId/photos/:photoId/reject', async (c) => {
    const { actor, venue } = await identity(c);
    const scope = DraftPhotoScopeSchema.safeParse(c.req.param());
    const input = RejectDraftPhotoSchema.safeParse(await json(c));
    if (!scope.success || !input.success) return c.json({ error: 'invalid_request' }, 400);
    const { photo } = await services.database(c.env, (client) =>
      rejectDraftPhoto(
        client,
        actor,
        venue,
        scope.data.draftId,
        scope.data.photoId,
        input.data.commandId,
      ),
    );
    return c.json({
      photo: {
        id: photo.id,
        draftId: photo.draft_id,
        verificationStatus: photo.verification_status,
      },
    });
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

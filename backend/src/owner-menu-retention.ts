import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import type { StorageBinding } from './owner-menu';

export type StagingRetentionOptions = {
  storage: StorageBinding & {
    list(options: { prefix: string; cursor?: string | undefined }): Promise<{
      objects: readonly { key: string; uploaded?: Date | string }[];
      truncated?: boolean;
      cursor?: string;
    }>;
  };
  client: Client;
  retentionConfig?: {
    promotedRetentionDays?: number | undefined;
    rejectedRetentionDays?: number;
    orphanGraceDays?: number;
  };
  dryRun?: boolean;
};
export type StagingRetentionResult = {
  scanned: number;
  promotedDeleted: number;
  rejectedDeleted: number;
  orphansDeleted: number;
  protectedPending: number;
  protectedInFlight: number;
  retained: number;
};

export async function cleanupStagedMenuPhotos({
  storage,
  client,
  retentionConfig,
  dryRun = false,
}: StagingRetentionOptions): Promise<StagingRetentionResult> {
  const result: StagingRetentionResult = {
    scanned: 0,
    promotedDeleted: 0,
    rejectedDeleted: 0,
    orphansDeleted: 0,
    protectedPending: 0,
    protectedInFlight: 0,
    retained: 0,
  };
  const {
    promotedRetentionDays: promotedDays,
    rejectedRetentionDays: rejectedDays = 0,
    orphanGraceDays: orphanDays = 0,
  } = retentionConfig ?? {};
  if (
    [promotedDays, rejectedDays, orphanDays].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
    )
  ) {
    throw new Error('invalid_menu_retention');
  }
  if (promotedDays === undefined && rejectedDays === 0 && orphanDays === 0) return result;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const keyPattern = new RegExp(`^menu-staging/(${uuid})/(${uuid})/([0-9a-f]{64})$`);
  const oldEnough = (date: Date | string | undefined, days: number) =>
    date !== undefined && Date.now() - new Date(date).getTime() >= days * 86_400_000;
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await storage.list({ prefix: 'menu-staging/', cursor });
    for (const object of page.objects) {
      if (!object.key.startsWith('menu-staging/')) continue;
      result.scanned++;
      const match = keyPattern.exec(object.key);
      if (!match) {
        result.retained++;
        continue;
      }
      const [, venueId, draftId, sourceHash] = match;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='2s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [venueId]);
        // Same draft lock as saves; row locks also serialize uploads and promotion.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `owner-draft:${venueId}:${draftId}`,
        ]);
        const draft = (
          await client.query<{ review_status: string }>(
            'SELECT review_status FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [venueId, draftId],
          )
        ).rows[0];
        const photo = (
          await client.query<{
            id: string;
            verification_status: string;
            storage_key: string;
            promoted_storage_key: string | null;
            updated_at: Date;
            size_bytes: number;
          }>(
            'SELECT * FROM app_private.dish_draft_photo WHERE tenant_id=$1 AND draft_id=$2 AND source_hash=$3 FOR UPDATE',
            [venueId, draftId, sourceHash],
          )
        ).rows[0];
        let category: 'promotedDeleted' | 'rejectedDeleted' | 'orphansDeleted' | undefined;
        if (
          photo?.verification_status === 'verified' &&
          promotedDays !== undefined &&
          photo.storage_key === `menu-assets/${venueId}/${photo.id}/${sourceHash}` &&
          photo.promoted_storage_key === photo.storage_key &&
          oldEnough(photo.updated_at, promotedDays)
        ) {
          const destination = await storage.get(photo.storage_key);
          const bytes = destination ? await destination.arrayBuffer() : null;
          if (
            bytes &&
            bytes.byteLength === photo.size_bytes &&
            createHash('sha256').update(Buffer.from(bytes)).digest('hex') === sourceHash
          )
            category = 'promotedDeleted';
        } else if (
          draft?.review_status === 'pending' ||
          photo?.verification_status === 'not_verified'
        ) {
          result.protectedPending++;
        } else if (
          photo?.verification_status === 'rejected' &&
          rejectedDays > 0 &&
          oldEnough(photo.updated_at, rejectedDays)
        ) {
          category = 'rejectedDeleted';
        } else if (!photo && orphanDays > 0 && oldEnough(object.uploaded, orphanDays)) {
          category = 'orphansDeleted';
        } else if (!photo) {
          result.protectedInFlight++;
        }
        if (category && !dryRun) await storage.delete(object.key);
        await client.query('COMMIT');
        if (category) result[category]++;
        else result.retained++;
      } catch {
        await client.query('ROLLBACK');
        result.retained++;
      }
    }
    if (!page.truncated) break;
    if (!page.cursor || seen.has(page.cursor)) throw new Error('invalid_menu_retention_cursor');
    seen.add(page.cursor);
    cursor = page.cursor;
  } while (cursor);
  return result;
}

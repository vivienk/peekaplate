import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import type { StorageBinding } from './owner-menu';

type RetentionObject = { key: string; uploaded?: Date | string };

export type StagingRetentionOptions = {
  storage: StorageBinding & {
    list(options: { prefix: string; cursor?: string | undefined }): Promise<{
      objects: readonly RetentionObject[];
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

const portionFiles = ['approval.json', 'record.json', 'background.svg', 'dish.webp'];

async function* listRetentionObjects(storage: StagingRetentionOptions['storage'], prefix: string) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await storage.list({ prefix, cursor });
    for (const object of page.objects) {
      if (object.key.startsWith(prefix)) yield object;
    }
    if (!page.truncated) return;
    if (!page.cursor || seen.has(page.cursor)) throw new Error('invalid_menu_retention_cursor');
    seen.add(page.cursor);
    cursor = page.cursor;
  } while (cursor);
}

async function listPortionFiles(storage: StagingRetentionOptions['storage'], prefix: string) {
  const listed = new Map<string, RetentionObject>();
  for await (const object of listRetentionObjects(storage, prefix)) {
    const filename = object.key.slice(prefix.length);
    if (portionFiles.includes(filename)) listed.set(filename, object);
  }
  // Remove approval, then invalidate the cache before deleting any layer it references.
  return portionFiles.flatMap((filename) => {
    const object = listed.get(filename);
    return object ? [object] : [];
  });
}

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
  const draftScope = `(?<venueId>${uuid})/(?<draftId>${uuid})`;
  const sourceHashPattern = '(?<sourceHash>[0-9a-f]{64})';
  const scans = [
    {
      prefix: 'menu-staging/',
      pattern: new RegExp(`^menu-staging/${draftScope}/${sourceHashPattern}$`),
    },
  ];
  if (rejectedDays > 0 || orphanDays > 0) {
    scans.push({
      prefix: 'private-portions/',
      pattern: new RegExp(
        `^private-portions/${draftScope}/(?<photoId>${uuid})/${sourceHashPattern}/(?:approval\\.json|background\\.svg|dish\\.webp|record\\.json)$`,
      ),
    });
  }
  const oldEnough = (date: Date | string | undefined, days: number) =>
    date !== undefined && Date.now() - new Date(date).getTime() >= days * 86_400_000;
  for (const { prefix, pattern } of scans) {
    const privatePortion = prefix === 'private-portions/';
    let lastPortionPrefix: string | undefined;
    for await (const object of listRetentionObjects(storage, prefix)) {
      const scope = pattern.exec(object.key)?.groups;
      if (!scope) {
        result.scanned++;
        result.retained++;
        continue;
      }
      const { venueId, draftId, sourceHash, photoId } = scope;
      const artifactPrefix = privatePortion
        ? object.key.slice(0, object.key.lastIndexOf('/') + 1)
        : '';
      if (artifactPrefix && artifactPrefix === lastPortionPrefix) continue;
      lastPortionPrefix = artifactPrefix;
      let candidates = [object];
      let category: 'promotedDeleted' | 'rejectedDeleted' | 'orphansDeleted' | undefined;
      let deleted = 0;
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
            `SELECT * FROM app_private.dish_draft_photo
              WHERE tenant_id=$1 AND draft_id=$2 AND source_hash=$3
                AND ($4::uuid IS NULL OR id=$4)
              FOR UPDATE`,
            [venueId, draftId, sourceHash, photoId ?? null],
          )
        ).rows[0];
        if (artifactPrefix) candidates = await listPortionFiles(storage, artifactPrefix);
        if (
          !privatePortion &&
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
          (!privatePortion && draft?.review_status === 'pending') ||
          photo?.verification_status === 'not_verified'
        ) {
          result.protectedPending += candidates.length;
        } else if (
          photo?.verification_status === 'rejected' &&
          rejectedDays > 0 &&
          oldEnough(photo.updated_at, rejectedDays) &&
          (!privatePortion ||
            candidates.every((candidate) => oldEnough(candidate.uploaded, rejectedDays)))
        ) {
          category = 'rejectedDeleted';
        } else if (
          !photo &&
          orphanDays > 0 &&
          candidates.every((candidate) => oldEnough(candidate.uploaded, orphanDays))
        ) {
          category = 'orphansDeleted';
        } else if (!photo) {
          result.protectedInFlight += candidates.length;
        }
        if (category) {
          for (const candidate of candidates) {
            if (!dryRun) await storage.delete(candidate.key);
            deleted++;
          }
        }
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
      }
      result.scanned += candidates.length;
      if (category) result[category] += deleted;
      result.retained += candidates.length - deleted;
    }
  }
  return result;
}

import type { Client } from 'pg';
import type { StorageBinding } from './owner-menu';

export type StagingRetentionOptions = {
  storage: StorageBinding & {
    list(options?: {
      prefix?: string;
    }): Promise<{ objects: readonly { key: string; uploaded?: Date | string }[] }>;
  };
  client: Client;
  retentionConfig?: {
    promotedRetentionDays?: number; // default 0: delete immediately once promoted reference confirmed
    rejectedRetentionDays?: number; // default undefined/0: disabled (never delete rejected)
    orphanGraceDays?: number; // default undefined/0: disabled (never delete unreferenced)
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

/**
 * Idempotently cleans up eligible staging objects in menu-staging/ without touching menu-assets/.
 *
 * Eligibility rules:
 * 1. Promoted: storage_key has been updated to menu-assets/ and verification_status = 'verified'.
 * 2. Rejected: verification_status = 'rejected' and retention period has elapsed (if configured).
 * 3. Orphan: no DB record in dish_draft_photo, and uploaded > orphanGraceDays ago.
 * 4. Invariant: active unverified photos on pending drafts are NEVER deleted.
 */
export async function cleanupStagedMenuPhotos(
  options: StagingRetentionOptions,
): Promise<StagingRetentionResult> {
  const result: StagingRetentionResult = {
    scanned: 0,
    promotedDeleted: 0,
    rejectedDeleted: 0,
    orphansDeleted: 0,
    protectedPending: 0,
    protectedInFlight: 0,
    retained: 0,
  };

  const { storage, client, retentionConfig, dryRun = false } = options;
  if (!storage || typeof storage.list !== 'function' || typeof storage.delete !== 'function') {
    return result;
  }

  // Retention is disabled by default unless explicitly configured with positive days (or 0 for immediate promoted cleanup)
  const promotedDays = retentionConfig?.promotedRetentionDays;
  const rejectedDays = retentionConfig?.rejectedRetentionDays ?? 0;
  const orphanDays = retentionConfig?.orphanGraceDays ?? 0;

  // If no retention rule is active, exit early
  if (promotedDays === undefined && rejectedDays <= 0 && orphanDays <= 0) {
    return result;
  }

  const listed = await storage.list({ prefix: 'menu-staging/' });
  const objects = listed.objects ?? [];

  for (const obj of objects) {
    // Invariant 1: Strictly check menu-staging/ prefix; menu-assets/ must NEVER be touched
    if (!obj.key.startsWith('menu-staging/')) continue;
    result.scanned += 1;

    // Key shape: menu-staging/{venueId}/{draftId}/{sourceHash}
    const parts = obj.key.split('/');
    if (parts.length < 4) {
      result.retained += 1;
      continue;
    }
    const venueId = parts[1];
    const draftId = parts[2];
    const sourceHash = parts[3];

    // Check DB record
    const photoRes = await client.query<{
      id: string;
      verification_status: string;
      storage_key: string;
      promoted_storage_key: string | null;
      updated_at: Date;
      draft_review_status: string | null;
    }>(
      `SELECT p.id, p.verification_status, p.storage_key, p.promoted_storage_key, p.updated_at, d.review_status AS draft_review_status
       FROM app_private.dish_draft_photo p
       LEFT JOIN app_private.dish_drafts d ON d.tenant_id = p.tenant_id AND d.id = p.draft_id
       WHERE p.tenant_id = $1 AND p.draft_id = $2 AND p.source_hash = $3`,
      [venueId, draftId, sourceHash],
    );

    const record = photoRes.rows[0];

    // Category 1: Promoted photos
    if (record && record.promoted_storage_key && record.verification_status === 'verified') {
      if (promotedDays !== undefined) {
        const msSinceUpdate = Date.now() - new Date(record.updated_at).getTime();
        if (msSinceUpdate >= promotedDays * 86_400_000) {
          if (!dryRun) await storage.delete(obj.key);
          result.promotedDeleted += 1;
          continue;
        }
      }
      result.retained += 1;
      continue;
    }

    // Category 2: Rejected photos
    if (record && record.verification_status === 'rejected') {
      // Invariant: Active review session / pending draft protects staging photo from deletion
      if (record.draft_review_status === 'pending') {
        result.protectedPending += 1;
        result.retained += 1;
        continue;
      }
      if (rejectedDays > 0) {
        const msSinceUpdate = Date.now() - new Date(record.updated_at).getTime();
        if (msSinceUpdate >= rejectedDays * 86_400_000) {
          if (!dryRun) await storage.delete(obj.key);
          result.rejectedDeleted += 1;
          continue;
        }
      }
      result.retained += 1;
      continue;
    }

    // Protection rule: Active pending draft photo is strictly protected
    if (record && record.verification_status === 'not_verified') {
      result.protectedPending += 1;
      result.retained += 1;
      continue;
    }

    // Category 3: Unreferenced orphan upload
    if (!record) {
      if (orphanDays > 0) {
        // Protect active review sessions / pending drafts
        const activeDraftRes = await client.query<{ id: string }>(
          `SELECT id FROM app_private.dish_drafts
           WHERE tenant_id = $1 AND id = $2 AND review_status = 'pending'`,
          [venueId, draftId],
        );
        if (activeDraftRes.rows[0]) {
          result.protectedPending += 1;
          result.retained += 1;
          continue;
        }

        const uploadedTime = obj.uploaded ? new Date(obj.uploaded).getTime() : Date.now();
        const msSinceUpload = Date.now() - uploadedTime;
        if (msSinceUpload >= orphanDays * 86_400_000) {
          if (!dryRun) await storage.delete(obj.key);
          result.orphansDeleted += 1;
          continue;
        }
      }
      result.protectedInFlight += 1;
      result.retained += 1;
      continue;
    }

    result.retained += 1;
  }

  return result;
}

import type { Client } from 'pg';

export type ArtworkRetentionStorage = {
  list(options: { prefix: string; cursor?: string | undefined }): Promise<{
    objects: readonly { key: string; uploaded?: Date | string }[];
    truncated?: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<unknown>;
};

export type ArtworkCleanupOptions = {
  storage: ArtworkRetentionStorage;
  client: Client;
  gracePeriodMs?: number | undefined;
  maxDeletes?: number | undefined;
  dryRun?: boolean | undefined;
  nowMs?: number | undefined;
};

export type ArtworkCleanupResult = {
  scanned: number;
  deleted: number;
  protectedApproved: number;
  protectedInFlight: number;
  retained: number;
  errors: number;
  truncated: boolean;
};

const DEFAULT_GRACE_PERIOD_MS = 3_600_000;
const DEFAULT_MAX_DELETES = 100;
const ARTWORK_KEY_PATTERN =
  /^ingredient-artwork\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})\.png$/;

/**
 * Deletes unreferenced, revoked, or superseded ingredient artwork objects under
 * `ingredient-artwork/` after a grace period, while protecting any object
 * still referenced by an approved record (including shared hashes).
 */
export async function cleanupOrphanedIngredientArtwork({
  storage,
  client,
  gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  maxDeletes = DEFAULT_MAX_DELETES,
  dryRun = false,
  nowMs = Date.now(),
}: ArtworkCleanupOptions): Promise<ArtworkCleanupResult> {
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    throw new Error('invalid_artwork_grace_period');
  }
  if (!Number.isInteger(maxDeletes) || maxDeletes < 1) {
    throw new Error('invalid_artwork_max_deletes');
  }

  const result: ArtworkCleanupResult = {
    scanned: 0,
    deleted: 0,
    protectedApproved: 0,
    protectedInFlight: 0,
    retained: 0,
    errors: 0,
    truncated: false,
  };

  let cursor: string | undefined;
  const seen = new Set<string>();

  do {
    const page = await storage.list({ prefix: 'ingredient-artwork/', cursor });
    for (const object of page.objects) {
      if (result.deleted >= maxDeletes) {
        result.truncated = true;
        return result;
      }
      if (!object.key.startsWith('ingredient-artwork/')) continue;
      result.scanned++;

      const match = ARTWORK_KEY_PATTERN.exec(object.key);
      if (!match) {
        result.retained++;
        continue;
      }

      if (object.uploaded === undefined) {
        result.protectedInFlight++;
        continue;
      }
      const uploadedMs = new Date(object.uploaded).getTime();
      if (!Number.isFinite(uploadedMs) || nowMs - uploadedMs < gracePeriodMs) {
        result.protectedInFlight++;
        continue;
      }

      const [, venueId, sha256] = match;
      let isApproved = false;
      try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
        const ref = await client.query(
          "SELECT 1 FROM app_private.ingredient_artwork_current WHERE tenant_id = $1 AND sha256 = $2 AND status = 'approved' LIMIT 1",
          [venueId, sha256],
        );
        isApproved = (ref.rowCount ?? ref.rows.length) > 0;
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Ignore rollback errors after failed read check. */
        }
        result.errors++;
        continue;
      }

      if (isApproved) {
        result.protectedApproved++;
        continue;
      }

      try {
        if (!dryRun) {
          await storage.delete(object.key);
        }
        result.deleted++;
      } catch {
        result.errors++;
      }
    }

    if (!page.truncated || !page.cursor || seen.has(page.cursor)) {
      break;
    }
    seen.add(page.cursor);
    cursor = page.cursor;
  } while (true);

  return result;
}

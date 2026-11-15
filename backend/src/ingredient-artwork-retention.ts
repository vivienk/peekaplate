import type { Client } from 'pg';

export type ArtworkRetentionStorage = {
  list(options: { prefix: string; cursor?: string | undefined }): Promise<{
    objects: readonly { key: string; uploaded?: Date | string }[];
    truncated?: boolean;
    cursor?: string;
  }>;
  head?(key: string): Promise<{ uploaded?: Date | string } | null>;
  delete(key: string): Promise<unknown>;
};

export type ArtworkCleanupOptions = {
  storage: ArtworkRetentionStorage;
  client: Client;
  gracePeriodMs?: number | undefined;
  maxDeletes?: number | undefined;
  maxScanned?: number | undefined;
  maxPages?: number | undefined;
  dryRun?: boolean | undefined;
  nowMs?: number | undefined;
};

export type ArtworkCleanupResult = {
  scanned: number;
  pagesScanned: number;
  deleted: number;
  protectedApproved: number;
  protectedInFlight: number;
  retained: number;
  errors: number;
  truncated: boolean;
};

const DEFAULT_GRACE_PERIOD_MS = 3_600_000;
const DEFAULT_MAX_DELETES = 100;
const DEFAULT_MAX_SCANNED = 1000;
const DEFAULT_MAX_PAGES = 20;
const ARTWORK_KEY_PATTERN =
  /^ingredient-artwork\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})\.png$/;

function isOlderThanGrace(
  uploaded: Date | string | undefined,
  gracePeriodMs: number,
  nowMs: number,
): boolean {
  if (uploaded === undefined) return false;
  const uploadedMs = new Date(uploaded).getTime();
  return Number.isFinite(uploadedMs) && nowMs - uploadedMs >= gracePeriodMs;
}

async function fetchApprovedHashesForVenue(
  client: Client,
  venueId: string,
  hashes: readonly string[],
): Promise<Set<string>> {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const ref = await client.query<{ sha256: string }>(
      "SELECT DISTINCT sha256 FROM app_private.ingredient_artwork_current WHERE tenant_id = $1 AND sha256 = ANY($2::text[]) AND status = 'approved'",
      [venueId, hashes],
    );
    await client.query('COMMIT');
    return new Set(ref.rows.map((r) => r.sha256));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the DB query failure. */
    }
    throw error;
  }
}

async function deleteOrphanWithBlobLock(params: {
  client: Client;
  storage: ArtworkRetentionStorage;
  venueId: string;
  key: string;
  sha256: string;
  gracePeriodMs: number;
  nowMs: number;
  dryRun: boolean;
}): Promise<'deleted' | 'protected_approved' | 'protected_in_flight' | 'missing'> {
  const { client, storage, venueId, key, sha256, gracePeriodMs, nowMs, dryRun } = params;
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `ingredient-artwork-blob:${venueId}:${sha256}`,
    ]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const ref = await client.query<{ sha256: string }>(
      "SELECT sha256 FROM app_private.ingredient_artwork_current WHERE tenant_id = $1 AND sha256 = $2 AND status = 'approved' LIMIT 1",
      [venueId, sha256],
    );
    if (ref.rows.length > 0) {
      await client.query('COMMIT');
      return 'protected_approved';
    }
    if (storage.head) {
      const latest = await storage.head(key);
      if (!latest) {
        await client.query('COMMIT');
        return 'missing';
      }
      if (!isOlderThanGrace(latest.uploaded, gracePeriodMs, nowMs)) {
        await client.query('COMMIT');
        return 'protected_in_flight';
      }
    }
    if (!dryRun) {
      await storage.delete(key);
    }
    await client.query('COMMIT');
    return 'deleted';
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the cleanup failure. */
    }
    throw error;
  }
}

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
  maxScanned = DEFAULT_MAX_SCANNED,
  maxPages = DEFAULT_MAX_PAGES,
  dryRun = false,
  nowMs = Date.now(),
}: ArtworkCleanupOptions): Promise<ArtworkCleanupResult> {
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    throw new Error('invalid_artwork_grace_period');
  }
  if (!Number.isInteger(maxDeletes) || maxDeletes < 1) {
    throw new Error('invalid_artwork_max_deletes');
  }
  if (!Number.isInteger(maxScanned) || maxScanned < 1) {
    throw new Error('invalid_artwork_max_scanned');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error('invalid_artwork_max_pages');
  }

  const result: ArtworkCleanupResult = {
    scanned: 0,
    pagesScanned: 0,
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
    if (
      result.pagesScanned >= maxPages ||
      result.scanned >= maxScanned ||
      result.deleted >= maxDeletes
    ) {
      result.truncated = true;
      return result;
    }

    const page = await storage.list({ prefix: 'ingredient-artwork/', cursor });
    result.pagesScanned++;

    // Collect eligible candidates grouped by venueId for batched DB lookup.
    const candidatesByVenue = new Map<string, Array<{ key: string; sha256: string }>>();
    let hitScanOrDeleteLimit = false;

    for (const object of page.objects) {
      if (result.scanned >= maxScanned) {
        result.truncated = true;
        hitScanOrDeleteLimit = true;
        break;
      }
      if (!object.key.startsWith('ingredient-artwork/')) continue;
      result.scanned++;

      const match = ARTWORK_KEY_PATTERN.exec(object.key);
      if (!match) {
        result.retained++;
        continue;
      }

      if (!isOlderThanGrace(object.uploaded, gracePeriodMs, nowMs)) {
        result.protectedInFlight++;
        continue;
      }

      const [, venueId, sha256] = match;
      if (!venueId || !sha256) {
        result.retained++;
        continue;
      }
      const list = candidatesByVenue.get(venueId) ?? [];
      list.push({ key: object.key, sha256 });
      candidatesByVenue.set(venueId, list);
    }

    for (const [venueId, candidates] of candidatesByVenue) {
      const uniqueHashes = [...new Set(candidates.map((c) => c.sha256))];
      let approvedHashes: Set<string>;
      try {
        approvedHashes = await fetchApprovedHashesForVenue(client, venueId, uniqueHashes);
      } catch {
        result.errors += candidates.length;
        continue;
      }

      for (const candidate of candidates) {
        if (approvedHashes.has(candidate.sha256)) {
          result.protectedApproved++;
          continue;
        }
        if (result.deleted >= maxDeletes) {
          result.truncated = true;
          return result;
        }

        // Serialize head + DB approval recheck + R2 delete under the per-blob advisory
        // lock shared with Phase C of reviewArtwork so an approved object cannot be deleted.
        try {
          const outcome = await deleteOrphanWithBlobLock({
            client,
            storage,
            venueId,
            key: candidate.key,
            sha256: candidate.sha256,
            gracePeriodMs,
            nowMs,
            dryRun,
          });
          if (outcome === 'protected_approved') {
            result.protectedApproved++;
          } else if (outcome === 'protected_in_flight') {
            result.protectedInFlight++;
          } else if (outcome === 'deleted') {
            result.deleted++;
          }
        } catch {
          result.errors++;
        }
      }
    }

    if (hitScanOrDeleteLimit) {
      return result;
    }
    if (!page.truncated || !page.cursor || seen.has(page.cursor)) {
      break;
    }
    seen.add(page.cursor);
    cursor = page.cursor;
  } while (true);

  return result;
}

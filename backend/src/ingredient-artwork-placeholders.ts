// Ingredient artwork placeholders (Part B of the automatic menu preparation design).
//
// When the OCR pipeline saves a menu's drafts, every ingredient label it found is recorded for
// the venue, so the artwork team can see which ingredients still need artwork. A placeholder
// carries no image and approves nothing: the diner keeps its existing fallback (bundled icon or
// the ingredient name as text) until a person approves real artwork through the review route.
import { ArtworkLabelSchema, artworkLabel } from '@peekaplate/contracts';
import type { Client } from 'pg';
import type { DatabaseClient } from './ingestion/repository';

/** Upper bound of labels recorded from one job; anything beyond is ignored, never an error. */
export const MAX_PLACEHOLDER_LABELS = 500;

/**
 * The normalized, unique artwork labels of a job's drafts, in first-seen order. Names the artwork
 * label rules cannot express (digits, symbols, over 120 characters) are skipped.
 */
export function placeholderLabels(
  drafts: ReadonlyArray<{ ingredients?: readonly unknown[] | null | undefined }>,
): string[] {
  const labels = new Set<string>();
  for (const draft of drafts) {
    for (const name of draft.ingredients ?? []) {
      if (typeof name !== 'string') continue;
      const label = artworkLabel(name);
      if (!ArtworkLabelSchema.safeParse(label).success) continue;
      labels.add(label);
      if (labels.size >= MAX_PLACEHOLDER_LABELS) return [...labels];
    }
  }
  return [...labels];
}

/**
 * Records placeholders inside the caller's transaction (tenant already set). Existing labels are
 * left as they are, so a retry or a second menu adds only new ingredients.
 */
export async function recordArtworkPlaceholders(
  client: DatabaseClient,
  params: { tenantId: string; jobId: string; labels: readonly string[] },
): Promise<number> {
  if (params.labels.length === 0) return 0;
  const result = await client.query(
    `INSERT INTO app_private.ingredient_artwork_placeholder (tenant_id, label, first_job_id)
     SELECT $1, label, $2 FROM unnest($3::text[]) AS label
     ON CONFLICT (tenant_id, label) DO NOTHING;`,
    [params.tenantId, params.jobId, [...params.labels]],
  );
  return result.rowCount ?? 0;
}

export type PendingArtwork = { label: string; firstSeenAt: string };

/** Labels a venue's menus use that have no approved artwork (never approved, or revoked). */
export async function listPendingArtwork(client: Client, venue: string): Promise<PendingArtwork[]> {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venue]);
    const result = await client.query<{ label: string; created_at: Date | string }>(
      `SELECT p.label, p.created_at
         FROM app_private.ingredient_artwork_placeholder p
         LEFT JOIN app_private.ingredient_artwork_current c
           ON c.tenant_id = p.tenant_id AND c.label = p.label AND c.status = 'approved'
        WHERE p.tenant_id = $1 AND c.label IS NULL
        ORDER BY p.label
        LIMIT ${MAX_PLACEHOLDER_LABELS}`,
      [venue],
    );
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      label: row.label,
      firstSeenAt: new Date(row.created_at).toISOString(),
    }));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the read failure. */
    }
    throw error;
  }
}

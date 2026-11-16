import type { StructuredDishDraft } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimIngestionJob,
  createIngestionJob,
  persistExtractedDrafts,
} from './ingestion/repository';
import { listPendingArtwork } from './ingredient-artwork-placeholders';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;

const draft = (index: number, ingredients: string[] | null): StructuredDishDraft =>
  ({
    draft_id: `placeholder-draft-${index}`,
    draft_index: index,
    name: `Synthetic dish ${index}`,
    description: null,
    category: null,
    price_amount: null,
    price_currency: null,
    ingredients,
    image_id: null,
    source_id: 'synthetic-source',
    source_text: `Synthetic dish ${index}`,
    code_point_spans: [],
    utf16_spans: [],
    review_warnings: [],
    status: 'needs_review',
  }) as StructuredDishDraft;

describe.skipIf(!runtimeUrl || !adminUrl)('ingredient artwork placeholders (real database)', () => {
  let admin: Client;
  let runtime: Client;
  const venue = crypto.randomUUID();
  const other = crypto.randomUUID();

  async function saveJob(tenantId: string, drafts: StructuredDishDraft[]) {
    const jobId = crypto.randomUUID();
    await createIngestionJob(runtime, {
      id: jobId,
      tenantId,
      sourceType: 'pdf',
      sourceHash: 'c'.repeat(64),
      idempotencyKey: `placeholders-${jobId}`,
    });
    const claim = await claimIngestionJob(runtime, { tenantId, jobId, workerId: 'placeholders' });
    expect(claim).not.toBeNull();
    const result = await persistExtractedDrafts(runtime, {
      tenantId,
      jobId,
      claimToken: claim!.claimToken,
      drafts,
    });
    return { jobId, result };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    runtime = new Client({ connectionString: runtimeUrl });
    await admin.connect();
    await runtime.connect();
    await admin.query(
      "INSERT INTO app_private.venues (id, name) VALUES ($1, 'Placeholder Venue A'), ($2, 'Placeholder Venue B')",
      [venue, other],
    );
  });

  afterAll(async () => {
    await runtime?.end().catch(() => {});
    await admin?.end().catch(() => {});
  });

  it('records each new ingredient once per venue as the OCR save completes', async () => {
    const first = await saveJob(venue, [
      draft(0, ['Coconut Milk', 'Basil']),
      draft(1, ['basil', 'Lime', '7up']),
      draft(2, null),
    ]);
    expect(first.result).toMatchObject({ persistedCount: 3, placeholderCount: 3 });

    // A second menu adds only the labels the venue has not used before.
    const second = await saveJob(venue, [draft(0, ['Lime', 'Mint'])]);
    expect(second.result.placeholderCount).toBe(1);

    const rows = await admin.query<{ label: string; first_job_id: string }>(
      'SELECT label, first_job_id FROM app_private.ingredient_artwork_placeholder WHERE tenant_id=$1 ORDER BY label',
      [venue],
    );
    expect(rows.rows).toEqual([
      { label: 'basil', first_job_id: first.jobId },
      { label: 'coconut milk', first_job_id: first.jobId },
      { label: 'lime', first_job_id: first.jobId },
      { label: 'mint', first_job_id: second.jobId },
    ]);
    // Placeholders create no artwork state.
    const artwork = await admin.query(
      'SELECT 1 FROM app_private.ingredient_artwork_current WHERE tenant_id=$1',
      [venue],
    );
    expect(artwork.rowCount).toBe(0);
  });

  it('lists only labels without approved artwork, and never another venue', async () => {
    await saveJob(other, [draft(0, ['Saffron'])]);
    await admin.query(
      `INSERT INTO app_private.ingredient_artwork_current (tenant_id, label, stream_id, version, status, sha256)
       VALUES ($1, 'basil', $2, 1, 'approved', $3), ($1, 'lime', $4, 2, 'revoked', NULL)`,
      [venue, crypto.randomUUID(), 'd'.repeat(64), crypto.randomUUID()],
    );
    const pending = await listPendingArtwork(runtime, venue);
    expect(pending.map((item) => item.label)).toEqual(['coconut milk', 'lime', 'mint']);
    expect((await listPendingArtwork(runtime, other)).map((item) => item.label)).toEqual([
      'saffron',
    ]);
  });
});

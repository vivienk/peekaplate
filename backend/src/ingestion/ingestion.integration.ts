import type { StructuredDishDraft } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveDishDraft,
  claimIngestionJob,
  createIngestionJob,
  failIngestionJob,
  getIngestionJob,
  IngestionError,
  listDishDrafts,
  persistExtractedDrafts,
} from './repository';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;

const isDbAvailable = Boolean(runtimeUrl && adminUrl);

describe.skipIf(!isDbAvailable)('Menu Ingestion Database Integration', () => {
  let adminClient: Client;
  let runtimeClient: Client;

  const venueId = crypto.randomUUID();
  const otherVenueId = crypto.randomUUID();
  const actorId = crypto.randomUUID();

  beforeAll(async () => {
    adminClient = new Client({ connectionString: adminUrl });
    runtimeClient = new Client({ connectionString: runtimeUrl });
    await adminClient.connect();
    await runtimeClient.connect();

    // Create test venues and staff memberships
    await adminClient.query(
      `INSERT INTO app_private.venues (id, name) VALUES
       ($1, 'Integration Venue A'),
       ($2, 'Integration Venue B')
       ON CONFLICT (id) DO NOTHING;`,
      [venueId, otherVenueId],
    );

    await adminClient.query(
      `INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (tenant_id, actor_id) DO NOTHING;`,
      [venueId, actorId],
    );
  });

  afterAll(async () => {
    await runtimeClient?.end().catch(() => {});
    await adminClient?.end().catch(() => {});
  });

  it('claims job and issues a unique fencing claim_token and incremented lease_generation', async () => {
    const jobId = crypto.randomUUID();
    await adminClient.query("SELECT set_config('app.tenant_id', $1, false);", [venueId]);

    const created = await createIngestionJob(adminClient, {
      id: jobId,
      tenantId: venueId,
      sourceType: 'url',
      sourceUrl: 'https://example.com/menu',
      idempotencyKey: `idem_claim_${jobId}`,
    });
    expect(created.status).toBe('queued');

    const claim1 = await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_1',
    });
    expect(claim1).not.toBeNull();
    expect(claim1?.claimToken).toBeDefined();
    expect(Number(claim1?.leaseGeneration)).toBe(1);

    // Immediate second claim while running returns null
    const duplicateClaim = await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_2',
    });
    expect(duplicateClaim).toBeNull();
  });

  it('rejects stale worker commit after lease reclamation by another worker', async () => {
    const jobId = crypto.randomUUID();
    await createIngestionJob(adminClient, {
      id: jobId,
      tenantId: venueId,
      sourceType: 'pdf',
      sourceStorageKey: 'menus/source.pdf',
      idempotencyKey: `idem_fencing_${jobId}`,
    });

    // Worker 1 claims job
    const claim1 = (await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_1',
    }))!;

    // Simulate Worker 1 stalling and lease expiring
    await adminClient.query(
      `UPDATE app_private.menu_ingestion_jobs
       SET locked_at = now() - interval '15 minutes'
       WHERE id = $1;`,
      [jobId],
    );

    // Worker 2 reclaims the job
    const claim2 = (await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_2',
    }))!;
    expect(Number(claim2.leaseGeneration)).toBe(2);
    expect(claim2.claimToken).not.toBe(claim1.claimToken);

    // Delayed Worker 1 wakes up and attempts to commit drafts with claim1
    const sampleDrafts: StructuredDishDraft[] = [
      {
        draft_id: 'draft_stale_1',
        draft_index: 0,
        name: 'Stale Item',
        description: null,
        category: null,
        price_amount: '9.99',
        price_currency: 'USD',
        ingredients: null,
        source_id: 'src_1',
        source_text: 'Stale Item $9.99',
        image_id: null,
        code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 16 }],
        utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 16 }],
        review_warnings: [],
        status: 'needs_review',
      },
    ];

    await expect(
      persistExtractedDrafts(adminClient, {
        tenantId: venueId,
        jobId,
        claimToken: claim1.claimToken,
        drafts: sampleDrafts,
      }),
    ).rejects.toThrow(IngestionError);

    // Verify 0 drafts committed by Worker 1
    const drafts = await listDishDrafts(adminClient, { tenantId: venueId, jobId });
    expect(drafts.length).toBe(0);

    // Worker 2 commits successfully with claim2
    const commit2 = await persistExtractedDrafts(adminClient, {
      tenantId: venueId,
      jobId,
      claimToken: claim2.claimToken,
      drafts: sampleDrafts,
    });
    expect(commit2.persistedCount).toBe(1);

    const completed = await getIngestionJob(adminClient, venueId, jobId);
    expect(completed?.status).toBe('complete');
  });

  it('updates pending drafts on retry and protects reviewed/accepted drafts', async () => {
    const jobId = crypto.randomUUID();
    await createIngestionJob(adminClient, {
      id: jobId,
      tenantId: venueId,
      sourceType: 'text',
      idempotencyKey: `idem_retry_${jobId}`,
    });

    const claim1 = (await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_1',
    }))!;

    const draft0: StructuredDishDraft = {
      draft_id: 'draft_item_0',
      draft_index: 0,
      name: 'Initial Soup',
      description: 'Vegetable broth',
      category: 'Starters',
      price_amount: '5.00',
      price_currency: 'USD',
      ingredients: ['carrots'],
      source_id: 'src_1',
      source_text: 'Initial Soup $5.00',
      image_id: null,
      code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 18 }],
      utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 18 }],
      review_warnings: [],
      status: 'needs_review',
    };

    const draft1: StructuredDishDraft = {
      ...draft0,
      draft_id: 'draft_item_1',
      draft_index: 1,
      name: 'Salad',
      source_text: 'Salad $5.00',
    };

    await persistExtractedDrafts(adminClient, {
      tenantId: venueId,
      jobId,
      claimToken: claim1.claimToken,
      drafts: [draft0, draft1],
    });

    const persistedDrafts = await listDishDrafts(adminClient, { tenantId: venueId, jobId });
    const persistedDraft0 = persistedDrafts.find((d) => d.draft_index === 0)!;

    // Staff reviews and accepts Draft 0
    const publishedDishId = crypto.randomUUID();
    await adminClient.query(
      `INSERT INTO app_private.dish_current (tenant_id, dish_id, version, revision_id, name, description)
       VALUES ($1, $2, 1, gen_random_uuid(), 'Published Soup', 'Accepted description');`,
      [venueId, publishedDishId],
    );

    await approveDishDraft(adminClient, {
      actorId,
      tenantId: venueId,
      draftId: persistedDraft0.id,
      publishedDishId,
    });

    // Retry job
    await adminClient.query(
      `UPDATE app_private.menu_ingestion_jobs
       SET status = 'incomplete', attempt_count = 1
       WHERE id = $1;`,
      [jobId],
    );

    const claimRetry = (await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_retry',
    }))!;

    // Retry produces corrected name for Draft 0 and updated name for Draft 1
    const correctedDraft0 = { ...draft0, name: 'AI Revised Soup (Should be ignored)' };
    const updatedDraft1 = { ...draft1, name: 'Garden Fresh Salad' };

    await persistExtractedDrafts(adminClient, {
      tenantId: venueId,
      jobId,
      claimToken: claimRetry.claimToken,
      drafts: [correctedDraft0, updatedDraft1],
    });

    const afterRetry = await listDishDrafts(adminClient, { tenantId: venueId, jobId });
    const afterDraft0 = afterRetry.find((d) => d.draft_index === 0)!;
    const afterDraft1 = afterRetry.find((d) => d.draft_index === 1)!;

    // Accepted Draft 0 strictly preserved human review
    expect(afterDraft0.review_status).toBe('accepted');
    expect(afterDraft0.name).toBe('Initial Soup'); // not overwritten by AI retry
    expect(afterDraft0.published_dish_id).toBe(publishedDishId);

    // Pending Draft 1 updated with corrected extraction
    expect(afterDraft1.review_status).toBe('pending');
    expect(afterDraft1.name).toBe('Garden Fresh Salad');
  });

  it('preserves exact decimal prices and zero prices without precision loss', async () => {
    const jobId = crypto.randomUUID();
    await createIngestionJob(adminClient, {
      id: jobId,
      tenantId: venueId,
      sourceType: 'text',
      idempotencyKey: `idem_decimal_${jobId}`,
    });

    const claim = (await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_decimal',
    }))!;

    const zeroPriceDraft: StructuredDishDraft = {
      draft_id: 'draft_zero_price',
      draft_index: 0,
      name: 'Complimentary Bread',
      description: null,
      category: null,
      price_amount: '0.00',
      price_currency: 'USD',
      ingredients: null,
      source_id: 'src_1',
      source_text: 'Complimentary Bread $0.00',
      image_id: null,
      code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 26 }],
      utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 26 }],
      review_warnings: [],
      status: 'needs_review',
    };

    const preciseDraft: StructuredDishDraft = {
      draft_id: 'draft_precise_price',
      draft_index: 1,
      name: 'Chef Tasting Platter',
      description: null,
      category: null,
      price_amount: '1250.755',
      price_currency: 'EUR',
      ingredients: null,
      source_id: 'src_1',
      source_text: 'Chef Tasting Platter 1250.755 EUR',
      image_id: null,
      code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 32 }],
      utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 32 }],
      review_warnings: [],
      status: 'needs_review',
    };

    await persistExtractedDrafts(adminClient, {
      tenantId: venueId,
      jobId,
      claimToken: claim.claimToken,
      drafts: [zeroPriceDraft, preciseDraft],
    });

    const drafts = await listDishDrafts(adminClient, { tenantId: venueId, jobId });
    const persistedZero = drafts.find((d) => d.draft_index === 0)!;
    const persistedPrecise = drafts.find((d) => d.draft_index === 1)!;

    expect(persistedZero.price_amount).toBe('0.00');
    expect(persistedPrecise.price_amount).toBe('1250.755');
  });
});

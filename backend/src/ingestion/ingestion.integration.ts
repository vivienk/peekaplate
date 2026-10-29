import type { StructuredDishDraft } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approveDishDraftAtomic } from '../index';
import { processIngestionQueueBatch, type QueueMessage, submitMenuIngestion } from './orchestrator';
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

  it('persists and reloads schema 2 / pipeline 3 fields (subcategory, price_text, category_page_number, candidate_id)', async () => {
    const jobId = crypto.randomUUID();
    await createIngestionJob(adminClient, {
      id: jobId,
      tenantId: venueId,
      sourceType: 'pdf',
      sourceStorageKey: 'menus/v2_source.pdf',
      idempotencyKey: `idem_v2_fields_${jobId}`,
    });

    const claim = (await claimIngestionJob(adminClient, {
      tenantId: venueId,
      jobId,
      workerId: 'worker_v2_fields',
    }))!;

    const v2Draft: StructuredDishDraft = {
      draft_id: 'draft_v2_grouped',
      candidate_id: 'cand_v2_grouped',
      draft_index: 0,
      name: 'Artisan Soup Duo',
      description: 'Choice of seasonal warm soups',
      category: 'Starters',
      subcategory: 'Soup Flights',
      category_page_number: 1,
      price_text: '8.50 / 12.50 CAD',
      price_amount: null, // Multi-option scalar null
      price_currency: 'CAD',
      ingredients: ['squash', 'herbs'],
      source_id: 'src_doc_v2',
      source_text: 'Artisan Soup Duo 8.50 / 12.50 CAD',
      image_id: null,
      code_point_spans: [
        { segment_id: 'seg_1', start: 0, end: 16 },
        { segment_id: 'seg_1', start: 17, end: 34 },
      ],
      utf16_spans: [
        { segment_id: 'seg_1', start: 0, end: 16 },
        { segment_id: 'seg_1', start: 17, end: 34 },
      ],
      review_warnings: ['Grouped price options'],
      status: 'needs_review',
    };

    await persistExtractedDrafts(adminClient, {
      tenantId: venueId,
      jobId,
      claimToken: claim.claimToken,
      drafts: [v2Draft],
      status: 'complete',
    });

    const drafts = await listDishDrafts(adminClient, { tenantId: venueId, jobId });
    expect(drafts).toHaveLength(1);
    const persisted = drafts[0]!;

    expect(persisted.draft_id).toBe('draft_v2_grouped');
    expect(persisted.candidate_id).toBe('cand_v2_grouped');
    expect(persisted.name).toBe('Artisan Soup Duo');
    expect(persisted.category).toBe('Starters');
    expect(persisted.subcategory).toBe('Soup Flights');
    expect(persisted.category_page_number).toBe(1);
    expect(persisted.price_text).toBe('8.50 / 12.50 CAD');
    expect(persisted.price_amount).toBeNull();
    expect(persisted.price_currency).toBe('CAD');
    expect(persisted.review_status).toBe('pending');
    expect(persisted.extraction_status).toBe('needs_review');
  });

  describe('FINDING 1, 2, 3 Regressions under peekaplate_runtime', () => {
    it('enforces RLS and transaction-local tenant context under peekaplate_runtime without pre-set session context', async () => {
      // 1. Verify connection begins without pre-configured session context
      const initialSetting = await runtimeClient.query(
        "SELECT current_setting('app.tenant_id', true) AS tenant",
      );
      expect(initialSetting.rows[0]?.tenant || null).toBeNull();

      // 2. Submit ingestion job under runtimeClient
      const jobId = crypto.randomUUID();
      const created = await createIngestionJob(runtimeClient, {
        id: jobId,
        tenantId: venueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        idempotencyKey: `idem_runtime_rls_${jobId}`,
      });
      expect(created.id).toBe(jobId);
      expect(created.tenant_id).toBe(venueId);

      // 3. Retrieve own-venue job under runtimeClient
      const retrieved = await getIngestionJob(runtimeClient, venueId, jobId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(jobId);

      // 4. Cross-venue retrieval under runtimeClient is blocked by RLS
      const crossRetrieved = await getIngestionJob(runtimeClient, otherVenueId, jobId);
      expect(crossRetrieved).toBeNull();

      // 5. Claim job under runtimeClient
      const claim = await claimIngestionJob(runtimeClient, {
        tenantId: venueId,
        jobId,
        workerId: 'worker_runtime_test',
      });
      expect(claim).not.toBeNull();
      expect(claim?.claimToken).toBeDefined();

      // 6. Persist drafts under runtimeClient
      const sampleDraft: StructuredDishDraft = {
        draft_id: `draft_rt_${jobId}`,
        draft_index: 0,
        name: 'Runtime RLS Dish',
        description: 'Testing tenant isolation',
        category: 'Mains',
        price_amount: '18.50',
        price_currency: 'USD',
        ingredients: null,
        source_id: 'src_rt',
        source_text: 'Runtime RLS Dish $18.50',
        image_id: null,
        code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 23 }],
        utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 23 }],
        review_warnings: [],
        status: 'needs_review',
      };

      const persistRes = await persistExtractedDrafts(runtimeClient, {
        tenantId: venueId,
        jobId,
        claimToken: claim!.claimToken,
        drafts: [sampleDraft],
        status: 'complete',
      });
      expect(persistRes.persistedCount).toBe(1);

      // 7. Own-venue draft listing under runtimeClient
      const ownDrafts = await listDishDrafts(runtimeClient, { tenantId: venueId, jobId });
      expect(ownDrafts).toHaveLength(1);
      expect(ownDrafts[0]?.name).toBe('Runtime RLS Dish');

      // 8. Cross-venue draft listing under runtimeClient returns empty list
      const foreignDrafts = await listDishDrafts(runtimeClient, { tenantId: otherVenueId, jobId });
      expect(foreignDrafts).toHaveLength(0);

      // 9. Session context remains empty after transaction commits
      const postSetting = await runtimeClient.query(
        "SELECT current_setting('app.tenant_id', true) AS tenant",
      );
      expect(postSetting.rows[0]?.tenant || null).toBeNull();
    });

    it('processes queue batch with runtimeClient without preconfigured context and never falsely ACKs as job_not_found', async () => {
      const jobId = crypto.randomUUID();
      await createIngestionJob(runtimeClient, {
        id: jobId,
        tenantId: venueId,
        sourceType: 'pdf',
        sourceHash: 'b'.repeat(64),
        idempotencyKey: `idem_runtime_queue_${jobId}`,
      });

      let acked = false;
      const queueMsg: QueueMessage = {
        body: {
          version: 1,
          tenantId: venueId,
          jobId,
          queuedAt: new Date().toISOString(),
        },
        attempts: 1,
        ack: () => {
          acked = true;
        },
        retry: vi.fn(),
      };

      const mockExtractor = vi.fn().mockResolvedValue({
        schema_version: 2,
        pipeline_version: '3',
        status: 'complete',
        started_at: '2026-10-27T12:00:00.000Z',
        finished_at: '2026-10-27T12:00:05.000Z',
        extraction_mode: 'ai',
        extraction_model: null,
        ocr_engine: 3,
        library_versions: {},
        configuration: {},
        source: {
          source_id: 'src_pdf_1',
          kind: 'pdf',
          sha256: 'b'.repeat(64),
          location: 'https://example.com/source',
          retrieved_at: '2026-10-27T12:00:00.000Z',
          size_bytes: 4096,
          snapshot_base64: Buffer.from('menu data').toString('base64'),
        },
        segments: [
          {
            segment_id: 'seg_1',
            page_number: 1,
            method: 'html',
            status: 'ready',
            text: 'Queued Runtime Dish $12.00',
            native_text: null,
            error: null,
            warnings: [],
            metadata: {},
          },
        ],
        drafts: [
          {
            draft_id: `draft_q_${jobId}`,
            draft_index: 0,
            name: 'Queued Runtime Dish',
            price_amount: '12.00',
            price_currency: 'USD',
            source_id: 'src_pdf_1',
            source_text: 'Queued Runtime Dish $12.00',
            review_warnings: [],
            status: 'needs_review',
          },
        ],
        evidence: [
          {
            draft_id: `draft_q_${jobId}`,
            draft_index: 0,
            spans: [{ segment_id: 'seg_1', start: 0, end: 26 }],
          },
        ],
      });

      const reportStorage = {
        put: vi.fn().mockResolvedValue(undefined),
      };

      await processIngestionQueueBatch(runtimeClient, { messages: [queueMsg] }, mockExtractor, {
        reportStorage,
      });

      expect(acked).toBe(true);

      const job = await getIngestionJob(runtimeClient, venueId, jobId);
      expect(job?.status).toBe('complete');
      expect(job?.draft_count).toBe(1);

      const drafts = await listDishDrafts(runtimeClient, { tenantId: venueId, jobId });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.name).toBe('Queued Runtime Dish');
    });

    it('atomically executes draft approval and dish revision creation with concurrency lock and es_command receipt', async () => {
      const runtimeClient2 = new Client({ connectionString: runtimeUrl });
      await runtimeClient2.connect();

      try {
        const jobId = crypto.randomUUID();
        await createIngestionJob(runtimeClient, {
          id: jobId,
          tenantId: venueId,
          sourceType: 'pdf',
          sourceHash: 'c'.repeat(64),
          idempotencyKey: `idem_atomic_${jobId}`,
        });

        const claim = (await claimIngestionJob(runtimeClient, {
          tenantId: venueId,
          jobId,
          workerId: 'worker_atomic',
        }))!;

        const draftData: StructuredDishDraft = {
          draft_id: `draft_atomic_${jobId}`,
          draft_index: 0,
          name: 'Atomic Wagyu Burger',
          description: 'Brioche bun with aged cheddar',
          category: 'Mains',
          price_amount: '22.00',
          price_currency: 'USD',
          ingredients: ['wagyu', 'cheddar'],
          source_id: 'src_atomic',
          source_text: 'Atomic Wagyu Burger $22.00',
          image_id: null,
          code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 26 }],
          utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 26 }],
          review_warnings: [],
          status: 'needs_review',
        };

        await persistExtractedDrafts(runtimeClient, {
          tenantId: venueId,
          jobId,
          claimToken: claim.claimToken,
          drafts: [draftData],
          status: 'complete',
        });

        const drafts = await listDishDrafts(runtimeClient, { tenantId: venueId, jobId });
        const targetDraft = drafts[0]!;

        // Two concurrent approval requests on the same draft
        const commandId1 = crypto.randomUUID();
        const commandId2 = crypto.randomUUID();

        const [res1, res2] = await Promise.allSettled([
          approveDishDraftAtomic(runtimeClient, actorId, venueId, targetDraft.id, {
            commandId: commandId1,
          }),
          approveDishDraftAtomic(runtimeClient2, actorId, venueId, targetDraft.id, {
            commandId: commandId2,
          }),
        ]);

        const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
        const rejections = [res1, res2].filter((r) => r.status === 'rejected');

        expect(successes).toHaveLength(1);
        expect(rejections).toHaveLength(1);

        const loserErr: any = (rejections[0] as PromiseRejectedResult).reason;
        expect(loserErr.status).toBe(404);
        expect(loserErr.code).toBe('draft_not_pending_or_not_found');

        // Verify draft was accepted and dish created
        const winnerResult = (successes[0] as PromiseFulfilledResult<any>).value;
        expect(winnerResult.draft.review_status).toBe('accepted');
        expect(winnerResult.publishedRevision.dishId).toBeDefined();

        // Check dish_current has exactly 1 entry
        const dishCheck = await adminClient.query(
          `SELECT dish_id, version, name FROM app_private.dish_current WHERE tenant_id = $1 AND dish_id = $2`,
          [venueId, winnerResult.publishedRevision.dishId],
        );
        expect(dishCheck.rows).toHaveLength(1);
        expect(dishCheck.rows[0]?.name).toBe('Atomic Wagyu Burger');

        // Test idempotency replay with winning commandId
        const winningCommandId = winnerResult.publishedRevision ? commandId1 : commandId2;
        const replay = await approveDishDraftAtomic(
          runtimeClient,
          actorId,
          venueId,
          targetDraft.id,
          { commandId: commandId1 },
        );
        expect(replay.publishedRevision.revisionId).toBe(winnerResult.publishedRevision.revisionId);
        expect(replay.publishedRevision.dishId).toBe(winnerResult.publishedRevision.dishId);
      } finally {
        await runtimeClient2.end().catch(() => {});
      }
    });

    it('rolls back all writes if draft approval fails mid-transaction', async () => {
      const jobId = crypto.randomUUID();
      await createIngestionJob(runtimeClient, {
        id: jobId,
        tenantId: venueId,
        sourceType: 'pdf',
        sourceHash: 'd'.repeat(64),
        idempotencyKey: `idem_rollback_${jobId}`,
      });

      const claim = (await claimIngestionJob(runtimeClient, {
        tenantId: venueId,
        jobId,
        workerId: 'worker_rollback',
      }))!;

      const draftData: StructuredDishDraft = {
        draft_id: `draft_rollback_${jobId}`,
        draft_index: 0,
        name: 'Rollback Salmon',
        description: null,
        category: null,
        price_amount: '28.00',
        price_currency: 'USD',
        ingredients: null,
        source_id: 'src_rb',
        source_text: 'Rollback Salmon $28.00',
        image_id: null,
        code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 22 }],
        utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 22 }],
        review_warnings: [],
        status: 'needs_review',
      };

      await persistExtractedDrafts(runtimeClient, {
        tenantId: venueId,
        jobId,
        claimToken: claim.claimToken,
        drafts: [draftData],
        status: 'complete',
      });

      const drafts = await listDishDrafts(runtimeClient, { tenantId: venueId, jobId });
      const targetDraft = drafts[0]!;

      // Unauthorized actor attempting approval
      const nonStaffActor = crypto.randomUUID();
      await expect(
        approveDishDraftAtomic(runtimeClient, nonStaffActor, venueId, targetDraft.id),
      ).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });

      // Assert draft is still pending
      const reloadedDrafts = await listDishDrafts(runtimeClient, { tenantId: venueId, jobId });
      expect(reloadedDrafts[0]?.review_status).toBe('pending');
      expect(reloadedDrafts[0]?.published_dish_id).toBeNull();
    });

    it('rejects raw URL submission before job creation or queue dispatch', async () => {
      const idemKey = `idem_url_reject_${crypto.randomUUID()}`;
      await expect(
        submitMenuIngestion(runtimeClient, {
          venueId,
          sourceType: 'url',
          sourceUrl: 'https://example.com/menu',
          idempotencyKey: idemKey,
        }),
      ).rejects.toMatchObject({
        code: 'unsupported_source_type',
        status: 400,
      });

      // Verify no job was created in database
      const check = await adminClient.query(
        `SELECT id FROM app_private.menu_ingestion_jobs WHERE tenant_id = $1 AND idempotency_key = $2`,
        [venueId, idemKey],
      );
      expect(check.rowCount).toBe(0);
    });
  });
});

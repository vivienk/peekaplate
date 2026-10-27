import type { StructuredDishDraft } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  approveDishDraft,
  claimIngestionJob,
  createIngestionJob,
  type DatabaseClient,
  failIngestionJob,
  getIngestionJob,
  IngestionError,
  listDishDrafts,
  persistExtractedDrafts,
  renewJobLease,
} from './repository';

function createMockClient() {
  const queries: Array<{ text: string; values?: unknown[] | undefined }> = [];
  let queryHandler: (
    text: string,
    values?: unknown[] | undefined,
  ) => { rows: any[]; rowCount: number } = () => ({
    rows: [],
    rowCount: 0,
  });

  const client: DatabaseClient = {
    async query(text, values) {
      queries.push({ text, values });
      return queryHandler(text, values);
    },
  };

  return {
    client,
    queries,
    setHandler(
      fn: (text: string, values?: unknown[] | undefined) => { rows: any[]; rowCount: number },
    ) {
      queryHandler = fn;
    },
  };
}

describe('Ingestion Repository', () => {
  const tenantId = '00000000-0000-0000-0000-000000000501';
  const jobId = '00000000-0000-0000-0000-000000000601';

  it('createIngestionJob executes parameterized insert with idempotency conflict handling', async () => {
    const mock = createMockClient();
    mock.setHandler((text, values) => {
      expect(text).toContain('INSERT INTO app_private.menu_ingestion_jobs');
      expect(text).toContain('ON CONFLICT (tenant_id, idempotency_key)');
      return {
        rows: [
          {
            id: values![0],
            tenant_id: values![1],
            source_type: values![2],
            source_url: values![3],
            idempotency_key: values![6],
            status: 'queued',
          },
        ],
        rowCount: 1,
      };
    });

    const job = await createIngestionJob(mock.client, {
      id: jobId,
      tenantId,
      sourceType: 'url',
      sourceUrl: 'https://example.com/menu',
      idempotencyKey: 'idem_123',
    });

    expect(job.id).toBe(jobId);
    expect(job.tenant_id).toBe(tenantId);
    expect(job.status).toBe('queued');
  });

  it('claimIngestionJob returns claim token and generation when claimable', async () => {
    const mock = createMockClient();
    mock.setHandler((text, values) => {
      expect(text).toContain('UPDATE app_private.menu_ingestion_jobs');
      expect(text).toContain('lease_generation = lease_generation + 1');
      expect(text).toContain("locked_at < now() - ($4 || ' minutes')::interval");
      return {
        rows: [
          {
            claim_token: '00000000-0000-0000-0000-000000000999',
            lease_generation: '1',
          },
        ],
        rowCount: 1,
      };
    });

    const claim = await claimIngestionJob(mock.client, {
      tenantId,
      jobId,
      workerId: 'worker_1',
      leaseTimeoutMinutes: 10,
    });

    expect(claim).not.toBeNull();
    expect(claim?.claimToken).toBe('00000000-0000-0000-0000-000000000999');
    expect(claim?.leaseGeneration).toBe('1');
  });

  it('claimIngestionJob returns null if job is already locked or in terminal state', async () => {
    const mock = createMockClient();
    mock.setHandler(() => ({ rows: [], rowCount: 0 }));

    const claim = await claimIngestionJob(mock.client, {
      tenantId,
      jobId,
      workerId: 'worker_1',
    });

    expect(claim).toBeNull();
  });

  it('renewJobLease returns true on successful heartbeat and false on timeout/mismatch', async () => {
    const mock = createMockClient();
    mock.setHandler((_text, values) => {
      const claimToken = values![2];
      return { rows: [], rowCount: claimToken === 'valid_token' ? 1 : 0 };
    });

    const renewed = await renewJobLease(mock.client, {
      tenantId,
      jobId,
      claimToken: 'valid_token',
    });
    expect(renewed).toBe(true);

    const expired = await renewJobLease(mock.client, {
      tenantId,
      jobId,
      claimToken: 'stale_token',
    });
    expect(expired).toBe(false);
  });

  it('persistExtractedDrafts rejects stale worker or expired lease with 409', async () => {
    const mock = createMockClient();
    mock.setHandler((text) => {
      if (text.includes('FOR UPDATE')) {
        // Lease expired or reclaimed
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      persistExtractedDrafts(mock.client, {
        tenantId,
        jobId,
        claimToken: 'stale_token',
        drafts: [],
      }),
    ).rejects.toThrow(IngestionError);

    expect(mock.queries.some((q) => q.text === 'ROLLBACK;')).toBe(true);
  });

  it('persistExtractedDrafts upserts drafts, supersedes surplus drafts, and marks job complete', async () => {
    const mock = createMockClient();
    let draftInsertCount = 0;
    let supersedeCount = 0;

    mock.setHandler((text) => {
      if (text === 'BEGIN;') return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE')) return { rows: [{ lease_generation: '1' }], rowCount: 1 };
      if (text.includes('INSERT INTO app_private.dish_drafts')) {
        draftInsertCount += 1;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("review_status = 'superseded'")) {
        supersedeCount = 2;
        return { rows: [], rowCount: 2 };
      }
      if (text.includes('status = $1') && text.includes('UPDATE app_private.menu_ingestion_jobs')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const drafts: StructuredDishDraft[] = [
      {
        draft_id: 'draft_1',
        draft_index: 0,
        name: 'Tuscan Soup',
        description: 'Warm soup',
        category: 'Starters',
        price_amount: '8.50',
        price_currency: 'USD',
        ingredients: ['Beans'],
        source_id: 'src_1',
        source_text: 'Tuscan Soup $8.50',
        image_id: null,
        code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 17 }],
        utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 17 }],
        review_warnings: [],
        status: 'needs_review' as const,
      },
    ];

    const result = await persistExtractedDrafts(mock.client, {
      tenantId,
      jobId,
      claimToken: 'active_token',
      drafts,
      status: 'complete',
    });

    expect(result.persistedCount).toBe(1);
    expect(result.supersededCount).toBe(2);
    expect(draftInsertCount).toBe(1);
    expect(mock.queries.some((q) => q.text === 'COMMIT;')).toBe(true);
  });

  it('failIngestionJob updates error details and transitions status safely', async () => {
    const mock = createMockClient();
    mock.setHandler((text, values) => {
      expect(text).toContain('UPDATE app_private.menu_ingestion_jobs');
      expect(text).toContain('error_code = $1');
      expect(text).toContain(
        "SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END",
      );
      expect(text).toContain(
        'finished_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END',
      );
      expect(values![0]).toBe('timeout_error');
      return { rows: [], rowCount: 1 };
    });

    await failIngestionJob(mock.client, {
      tenantId,
      jobId,
      claimToken: 'active_token',
      errorCode: 'timeout_error',
      errorDetails: 'Connection to OCR timed out',
    });

    expect(mock.queries.length).toBe(1);
  });

  it('Finding B: preserves original producer draft_index across filtering and persistence', async () => {
    const mock = createMockClient();
    const insertedIndices: number[] = [];

    mock.setHandler((text, values) => {
      if (text === 'BEGIN;') return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE')) return { rows: [{ lease_generation: '1' }], rowCount: 1 };
      if (text.includes('INSERT INTO app_private.dish_drafts')) {
        // Parameter $6 is draft_index
        insertedIndices.push(values![5] as number);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    // Producer drafts had original indices 0, 2, 7 (e.g., drafts 1, 3-6 were filtered or rejected)
    const drafts: StructuredDishDraft[] = [
      {
        draft_id: 'draft_0',
        candidate_id: 'cand_0',
        draft_index: 0,
        name: 'Dish Zero',
        description: null,
        category: 'Starters',
        subcategory: 'Soups',
        category_page_number: 1,
        price_text: '5.00',
        price_amount: '5.00',
        price_currency: 'USD',
        ingredients: null,
        source_id: 'src_1',
        source_text: 'Dish Zero $5.00',
        image_id: null,
        code_point_spans: [{ segment_id: 'seg_1', start: 0, end: 15 }],
        utf16_spans: [{ segment_id: 'seg_1', start: 0, end: 15 }],
        review_warnings: [],
        status: 'needs_review' as const,
      },
      {
        draft_id: 'draft_2',
        candidate_id: 'cand_2',
        draft_index: 2,
        name: 'Dish Two',
        description: null,
        category: 'Mains',
        subcategory: null,
        category_page_number: 2,
        price_text: '15.00',
        price_amount: '15.00',
        price_currency: 'USD',
        ingredients: null,
        source_id: 'src_1',
        source_text: 'Dish Two $15.00',
        image_id: null,
        code_point_spans: [{ segment_id: 'seg_1', start: 16, end: 31 }],
        utf16_spans: [{ segment_id: 'seg_1', start: 16, end: 31 }],
        review_warnings: [],
        status: 'needs_review' as const,
      },
      {
        draft_id: 'draft_7',
        candidate_id: 'cand_7',
        draft_index: 7,
        name: 'Dish Seven',
        description: null,
        category: 'Desserts',
        subcategory: 'Cakes',
        category_page_number: 3,
        price_text: '8.00',
        price_amount: '8.00',
        price_currency: 'USD',
        ingredients: null,
        source_id: 'src_1',
        source_text: 'Dish Seven $8.00',
        image_id: null,
        code_point_spans: [{ segment_id: 'seg_1', start: 32, end: 48 }],
        utf16_spans: [{ segment_id: 'seg_1', start: 32, end: 48 }],
        review_warnings: [],
        status: 'needs_review' as const,
      },
    ];

    const result = await persistExtractedDrafts(mock.client, {
      tenantId,
      jobId,
      claimToken: 'active_token',
      drafts,
      status: 'complete',
    });

    expect(result.persistedCount).toBe(3);
    // Crucial Finding B assertion: must preserve [0, 2, 7], NOT replaced by array index [0, 1, 2]
    expect(insertedIndices).toEqual([0, 2, 7]);
  });

  it('Finding C: claimIngestionJob resets finished_at to NULL when reclaiming a job', async () => {
    const mock = createMockClient();
    mock.setHandler((text) => {
      expect(text).toContain('finished_at = NULL');
      return {
        rows: [{ claim_token: '00000000-0000-0000-0000-000000000999', lease_generation: '2' }],
        rowCount: 1,
      };
    });

    const claim = await claimIngestionJob(mock.client, {
      tenantId,
      jobId,
      workerId: 'worker_retry',
    });

    expect(claim).not.toBeNull();
  });

  it('approveDishDraft accepts pending draft and links published dish projection', async () => {
    const mock = createMockClient();
    const draftId = '00000000-0000-0000-0000-000000000701';
    const dishId = '00000000-0000-0000-0000-000000000801';
    const actorId = '00000000-0000-0000-0000-000000000201';

    mock.setHandler((text, values) => {
      expect(text).toContain("review_status = 'accepted'");
      expect(text).toContain('published_dish_id = $2');
      return {
        rows: [
          {
            id: values![3],
            tenant_id: values![2],
            review_status: 'accepted',
            reviewed_by: values![0],
            published_dish_id: values![1],
          },
        ],
        rowCount: 1,
      };
    });

    const approved = await approveDishDraft(mock.client, {
      actorId,
      tenantId,
      draftId,
      publishedDishId: dishId,
    });

    expect(approved.id).toBe(draftId);
    expect(approved.review_status).toBe('accepted');
    expect(approved.published_dish_id).toBe(dishId);
  });
});

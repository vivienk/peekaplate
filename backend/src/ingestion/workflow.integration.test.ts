import type { MenuExtractionResult } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { mintExtractionCapability } from '../extraction-capability';
import { prepareS3Vis01Handoff } from '../retrieval/handoff';
import {
  executeIngestionWorkflow,
  processIngestionQueueBatch,
  type QueueBatch,
  type QueueMessage,
  type ReportStorage,
  submitMenuIngestion,
} from './orchestrator';
import {
  claimIngestionJob,
  type DatabaseClient,
  IngestionError,
  type MenuIngestionJobRow,
  persistExtractedDrafts,
} from './repository';
import { createHttpPythonExtractor, DEFAULT_EXTRACTION_TIMEOUT_MS } from './transport';

function createMockDatabase() {
  const store: {
    job?: MenuIngestionJobRow;
    drafts: any[];
    completedStatuses: Array<{ status: string; draftCount: number; resultKey: string | null }>;
  } = { drafts: [], completedStatuses: [] };

  const client: DatabaseClient = {
    async query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number }> {
      // 1. Ingestion job insert / on conflict do update
      if (text.includes('INSERT INTO app_private.menu_ingestion_jobs')) {
        if (
          store.job &&
          store.job.tenant_id === values![1] &&
          store.job.idempotency_key === values![6]
        ) {
          return { rows: [store.job as unknown as R], rowCount: 1 };
        }
        const job: MenuIngestionJobRow = {
          id: values![0] as string,
          tenant_id: values![1] as string,
          source_type: values![2] as any,
          source_url: values![3] as string | null,
          source_hash: values![4] as string | null,
          source_storage_key: values![5] as string | null,
          result_storage_key: null,
          idempotency_key: values![6] as string,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          claim_token: null,
          lease_generation: '0',
          locked_at: null,
          locked_by: null,
          error_code: null,
          error_details: null,
          draft_count: 0,
          created_at: new Date().toISOString(),
          started_at: null,
          finished_at: null,
        };
        store.job = job;
        return { rows: [job as unknown as R], rowCount: 1 };
      }

      // 2. Claim job lease
      if (
        text.includes('UPDATE app_private.menu_ingestion_jobs') &&
        text.includes('claim_token = gen_random_uuid()')
      ) {
        if (!store.job || (store.job.status !== 'queued' && store.job.status !== 'incomplete')) {
          return { rows: [], rowCount: 0 };
        }
        store.job.status = 'running';
        store.job.claim_token = '00000000-0000-0000-0000-000000000999';
        store.job.lease_generation = '1';
        store.job.locked_at = new Date().toISOString();
        return {
          rows: [
            {
              claim_token: store.job.claim_token,
              lease_generation: store.job.lease_generation,
            } as unknown as R,
          ],
          rowCount: 1,
        };
      }

      // 3. Select job
      if (text.includes('SELECT * FROM app_private.menu_ingestion_jobs')) {
        return { rows: store.job ? [store.job as unknown as R] : [], rowCount: store.job ? 1 : 0 };
      }

      // 4. Row locking FOR UPDATE
      if (text.includes('FOR UPDATE')) {
        return { rows: [{ lease_generation: '1' } as unknown as R], rowCount: 1 };
      }

      // 5. Insert dish draft
      if (text.includes('INSERT INTO app_private.dish_drafts')) {
        store.drafts.push(values);
        return { rows: [], rowCount: 1 };
      }

      // 6. Complete job & release lease
      if (
        text.includes('SET status = $1') &&
        text.includes('UPDATE app_private.menu_ingestion_jobs')
      ) {
        if (store.job) {
          store.job.status = values![0] as any;
          store.job.draft_count = values![1] as number;
          store.job.result_storage_key = values![2] as string | null;
          store.job.claim_token = null;
          store.job.locked_at = null;
          store.completedStatuses.push({
            status: store.job.status,
            draftCount: store.job.draft_count,
            resultKey: store.job.result_storage_key,
          });
        }
        return { rows: [], rowCount: 1 };
      }

      // 7. Fail job
      if (text.includes('SET status = CASE WHEN attempt_count >= max_attempts')) {
        if (store.job) {
          store.job.status = 'failed';
          store.job.error_code = values![0] as string;
          store.job.error_details = values![1] as string;
        }
        return { rows: [], rowCount: 1 };
      }

      // 8. Transaction control
      if (['BEGIN;', 'COMMIT;', 'ROLLBACK;'].includes(text)) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return { client, store };
}

describe('S3-VIS-01 Menu Ingestion End-to-End Integration Suite', () => {
  const venueId = '00000000-0000-0000-0000-000000000001';
  const signingSecret = 'test-secret-at-least-48-characters-long-for-hmac-sha256-signing';

  function createMockReportStorage() {
    const reports = new Map<string, string>();
    const storage: ReportStorage = {
      async put(key: string, data: string): Promise<void> {
        reports.set(key, data);
      },
      async get(key: string): Promise<string | null> {
        return reports.get(key) ?? null;
      },
    };
    return { storage, reports };
  }

  function createStandardExtractionResult(
    sourceType: 'url' | 'pdf' | 'photo',
  ): MenuExtractionResult {
    return {
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
        source_id: `src_${sourceType}_1`,
        kind: sourceType === 'url' ? 'website' : sourceType === 'photo' ? 'image' : 'pdf',
        sha256: 'c'.repeat(64),
        location: `https://example.com/source`,
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
          text: 'Truffle Tagliolini $28.50 Handmade pasta with shaved black truffle',
          native_text: null,
          error: null,
          warnings: [],
          metadata: {},
        },
      ],
      drafts: [
        {
          draft_id: 'draft_tagliolini_1',
          draft_index: 0,
          name: 'Truffle Tagliolini',
          description: 'Handmade pasta with shaved black truffle',
          category: 'Primi',
          subcategory: 'Pasta',
          category_page_number: 1,
          price_text: '$28.50',
          price_amount: '28.50',
          price_currency: 'USD',
          ingredients: ['Handmade pasta', 'Black truffle'],
          source_id: `src_${sourceType}_1`,
          source_text: 'Truffle Tagliolini $28.50 Handmade pasta with shaved black truffle',
          image_id: null,
          review_warnings: [],
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft_tagliolini_1',
          draft_index: 0,
          spans: [
            {
              segment_id: 'seg_1',
              start: 0,
              end: 66,
            },
          ],
        },
      ],
      capture_requests: [],
      warnings: [],
      errors: [],
    };
  }

  describe('MOCKED INTEGRATION TEST: Full Menu-to-Draft Workflow across Source Types', () => {
    it('executes complete URL menu ingestion workflow to draft persistence', async () => {
      const { client, store } = createMockDatabase();
      const { storage, reports } = createMockReportStorage();

      // 1. Submit URL menu with pre-materialized content digest
      const urlHash = 'c'.repeat(64);
      const job = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'https://restaurant.example.com/dinner-menu',
        sourceHash: urlHash,
        idempotencyKey: 'idem_url_e2e_1',
      });

      expect(job.status).toBe('queued');
      expect(job.source_type).toBe('url');
      expect(job.source_url).toBe('https://restaurant.example.com/dinner-menu');
      expect(job.source_hash).toBe(urlHash);
      expect(job.source_storage_key).toBe(`menu-ingestion/sources/${venueId}/${job.id}/source`);

      // 2. Execute workflow with mocked extractor
      const mockResult = createStandardExtractionResult('url');
      const workflowResult = await executeIngestionWorkflow(client, {
        tenantId: venueId,
        jobId: job.id,
        workerId: 'worker_url_1',
        extractor: async (jobRow) => {
          expect(jobRow.id).toBe(job.id);
          expect(jobRow.source_hash).toBe(job.source_hash);
          return mockResult;
        },
        reportStorage: storage,
      });

      // 3. Verify workflow outcome
      expect(workflowResult.job.status).toBe('complete');
      expect(workflowResult.persistedCount).toBe(1);
      expect(workflowResult.drafts.length).toBe(1);

      const draft = workflowResult.drafts[0]!;
      expect(draft.name).toBe('Truffle Tagliolini');
      expect(draft.price_amount).toBe('28.50');
      expect(draft.price_currency).toBe('USD');
      expect(draft.category).toBe('Primi');
      expect(draft.subcategory).toBe('Pasta');
      expect(draft.category_page_number).toBe(1);
      expect(draft.price_text).toBe('$28.50');
      expect(draft.status).toBe('needs_review');

      // 4. Verify report artifact persisted in storage
      const reportKey = `reports/${venueId}/${job.id}/extraction.json`;
      expect(reports.has(reportKey)).toBe(true);
      const parsedReport = JSON.parse(reports.get(reportKey)!);
      expect(parsedReport.schema_version).toBe(2);

      // 5. Verify database draft record structure
      expect(store.drafts.length).toBe(1);
      const persistedDraftValues = store.drafts[0];
      expect(persistedDraftValues[1]).toBe(venueId); // tenant_id
      expect(persistedDraftValues[2]).toBe(job.id); // job_id
      expect(persistedDraftValues[5]).toBe(0); // draft_index
      expect(persistedDraftValues[6]).toBe('Truffle Tagliolini'); // name
      expect(persistedDraftValues[12]).toBe('28.50'); // price_amount
      expect(persistedDraftValues[13]).toBe('USD'); // price_currency
    });

    it('executes complete PDF menu ingestion workflow to draft persistence', async () => {
      const { client, store } = createMockDatabase();
      const { storage, reports } = createMockReportStorage();

      const pdfHash = 'a'.repeat(64);
      const job = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: pdfHash,
        idempotencyKey: 'idem_pdf_e2e_1',
      });

      expect(job.status).toBe('queued');
      expect(job.source_type).toBe('pdf');
      expect(job.source_hash).toBe(pdfHash);

      const mockResult = createStandardExtractionResult('pdf');
      const workflowResult = await executeIngestionWorkflow(client, {
        tenantId: venueId,
        jobId: job.id,
        workerId: 'worker_pdf_1',
        extractor: async () => mockResult,
        reportStorage: storage,
      });

      expect(workflowResult.job.status).toBe('complete');
      expect(workflowResult.persistedCount).toBe(1);
      expect(store.drafts.length).toBe(1);
      expect(reports.has(`reports/${venueId}/${job.id}/extraction.json`)).toBe(true);
    });

    it('executes complete Photo menu ingestion workflow to draft persistence', async () => {
      const { client, store } = createMockDatabase();
      const { storage, reports } = createMockReportStorage();

      const photoHash = 'b'.repeat(64);
      const job = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'photo',
        sourceHash: photoHash,
        idempotencyKey: 'idem_photo_e2e_1',
      });

      expect(job.status).toBe('queued');
      expect(job.source_type).toBe('photo');
      expect(job.source_hash).toBe(photoHash);

      const mockResult = createStandardExtractionResult('photo');
      const workflowResult = await executeIngestionWorkflow(client, {
        tenantId: venueId,
        jobId: job.id,
        workerId: 'worker_photo_1',
        extractor: async () => mockResult,
        reportStorage: storage,
      });

      expect(workflowResult.job.status).toBe('complete');
      expect(workflowResult.persistedCount).toBe(1);
      expect(store.drafts.length).toBe(1);
      expect(reports.has(`reports/${venueId}/${job.id}/extraction.json`)).toBe(true);
    });
  });

  describe('MOCKED INTEGRATION TEST: VIS-04 Retrieval Evidence Handoff to Draft Persistence', () => {
    it('adapts bounded retrieval result via prepareS3Vis01Handoff and persists drafts with exact spans', async () => {
      const { client, store } = createMockDatabase();

      // Simulated bounded retrieval result from VIS-04 (retriever)
      const sampleSha = 'd8b2e3f4a5c60123456789abcdef0123456789abcdef0123456789abcdef1234';
      const sampleText = 'Wood-fired Wagyu Ribeye $65.00 with truffle butter';
      const mockRetrievalResult = {
        schema_version: 1,
        status: 'success' as const,
        passages: [
          {
            passage_id: 'pass_wagyu_1',
            text: sampleText,
            start_offset: 0,
            end_offset: sampleText.length,
            rank: 1,
            score: 0.98,
            source: {
              source_id: `sha256:${sampleSha}`,
              segment_id: `sha256:${sampleSha}#page-1`,
              source_sha256: sampleSha,
              original_url: 'https://steakhouse.example.com/menu',
              final_url: 'https://steakhouse.example.com/menu.html',
              retrieved_at: '2026-10-27T10:00:00.000Z',
            },
          },
        ],
        warnings: [],
      };

      // 1. Transform via VIS-04 handoff adapter
      const handoff = prepareS3Vis01Handoff(
        mockRetrievalResult,
        { dishName: 'Wagyu Ribeye', currency: 'USD' },
        {
          sourceSegments: {
            [`sha256:${sampleSha}#page-1`]: sampleText,
          },
        },
      );

      expect(handoff.readyForIngestion).toBe(true);
      expect(handoff.candidates.length).toBe(1);

      const candidate = handoff.candidates[0]!;
      expect(candidate.name).toBe('Wagyu Ribeye');
      expect(candidate.source_id).toBe(`sha256:${sampleSha}`);
      expect(candidate.evidence.spans.length).toBe(1);
      expect(candidate.evidence.spans[0]?.start).toBe(0);
      expect(candidate.evidence.spans[0]?.end).toBe(sampleText.length);

      // 2. Create job and persist transformed drafts
      const job = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'https://steakhouse.example.com/menu',
        idempotencyKey: 'idem_retrieval_handoff_1',
      });

      const claim = await claimIngestionJob(client, {
        tenantId: venueId,
        jobId: job.id,
        workerId: 'worker_retrieval_1',
      });
      expect(claim).not.toBeNull();

      const contractDrafts = handoff.candidates.map((cand, idx) => ({
        draft_id: cand.evidence.draft_id,
        candidate_id: cand.evidence.draft_id,
        draft_index: idx,
        name: cand.name,
        description: cand.description ?? null,
        category: null,
        price_amount: null,
        price_currency: cand.price_currency ?? null,
        ingredients: null,
        source_id: cand.source_id,
        source_text: cand.source_text,
        image_id: null,
        code_point_spans: cand.evidence.spans,
        utf16_spans: cand.evidence.spans,
        review_warnings: cand.review_warnings,
        status: 'needs_review' as const,
      }));

      const persistResult = await persistExtractedDrafts(client, {
        tenantId: venueId,
        jobId: job.id,
        claimToken: claim!.claimToken,
        drafts: contractDrafts,
        status: 'complete',
      });

      expect(persistResult.persistedCount).toBe(1);
      expect(store.drafts.length).toBe(1);

      const persistedDraft = store.drafts[0];
      expect(persistedDraft[6]).toBe('Wagyu Ribeye'); // name
      expect(persistedDraft[13]).toBe('USD'); // price_currency
      expect(persistedDraft[16]).toBe('Wood-fired Wagyu Ribeye $65.00 with truffle butter'); // source_text
    });
  });

  describe('MOCKED INTEGRATION TEST: Provider Error Handling via HTTP Transport', () => {
    const fakeJob: MenuIngestionJobRow = {
      id: '00000000-0000-0000-0000-000000000010',
      tenant_id: venueId,
      source_type: 'pdf',
      source_url: null,
      source_hash: 'd'.repeat(64),
      source_storage_key: `menu-ingestion/sources/${venueId}/00000000-0000-0000-0000-000000000010/source`,
      result_storage_key: null,
      idempotency_key: 'idem_transport_err',
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      claim_token: null,
      lease_generation: '0',
      locked_at: null,
      locked_by: null,
      error_code: null,
      error_details: null,
      draft_count: 0,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
    };

    it('handles 401 Unauthorized from extraction service as extraction_service_error', async () => {
      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extraction-staging.example.com',
        authToken: 'invalid-secret',
        fetchFn: (async () =>
          new Response('Unauthorized: invalid service secret', { status: 401 })) as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'extraction_service_error',
        status: 400,
      });
    });

    it('handles 403 Forbidden from capability mismatch as extraction_service_error', async () => {
      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extraction-staging.example.com',
        authToken: 'valid-secret',
        sourceSigningSecret: signingSecret,
        fetchFn: (async () =>
          new Response('Forbidden: capability scope mismatch', { status: 403 })) as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'extraction_service_error',
        status: 400,
      });
    });

    it('handles 504 Gateway Timeout from extraction container', async () => {
      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extraction-staging.example.com',
        fetchFn: (async () => {
          const timeoutErr = new Error('The operation was aborted due to timeout');
          timeoutErr.name = 'TimeoutError';
          throw timeoutErr;
        }) as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'extraction_timeout',
        status: 504,
      });
    });

    it('handles 502 Bad Gateway with malformed JSON body', async () => {
      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extraction-staging.example.com',
        fetchFn: (async () =>
          new Response('<p>502 Bad Gateway - Container Crashing</p>', {
            status: 200, // Misconfigured proxy returning HTML 200
            headers: { 'Content-Type': 'text/html' },
          })) as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'malformed_extraction_response',
        status: 502,
      });
    });

    it('verifies transport timeout budget default is 720,000ms (12 minutes)', () => {
      expect(DEFAULT_EXTRACTION_TIMEOUT_MS).toBe(720_000);
    });
  });

  describe('MOCKED INTEGRATION TEST: Idempotency Key Consistency and Conflict Rejection', () => {
    it('returns existing job on identical URL re-submission', async () => {
      const { client } = createMockDatabase();

      const job1 = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'idem_url_idempotent_1',
      });

      const job2 = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'idem_url_idempotent_1',
      });

      expect(job2.id).toBe(job1.id);
      expect(job2.source_hash).toBe(job1.source_hash);
    });

    it('rejects re-submission with same idempotency key but conflicting sourceUrl with 409', async () => {
      const { client } = createMockDatabase();

      await submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'https://example.com/original-menu',
        idempotencyKey: 'idem_conflict_url_1',
      });

      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'url',
          sourceUrl: 'https://example.com/different-menu',
          idempotencyKey: 'idem_conflict_url_1',
        }),
      ).rejects.toMatchObject({
        code: 'idempotency_conflict',
        status: 409,
      });
    });

    it('rejects re-submission with same idempotency key but conflicting sourceType with 409', async () => {
      const { client } = createMockDatabase();

      await submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: 'e'.repeat(64),
        idempotencyKey: 'idem_conflict_type_1',
      });

      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'photo',
          sourceHash: 'e'.repeat(64),
          idempotencyKey: 'idem_conflict_type_1',
        }),
      ).rejects.toMatchObject({
        code: 'idempotency_conflict',
        status: 409,
      });
    });

    it('rejects re-submission with same idempotency key but conflicting sourceHash with 409', async () => {
      const { client } = createMockDatabase();

      await submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: '1'.repeat(64),
        idempotencyKey: 'idem_conflict_hash_1',
      });

      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'pdf',
          sourceHash: '2'.repeat(64),
          idempotencyKey: 'idem_conflict_hash_1',
        }),
      ).rejects.toMatchObject({
        code: 'idempotency_conflict',
        status: 409,
      });
    });

    it('rejects re-submission with same idempotency key when sourceUrl is omitted in second request', async () => {
      const { client } = createMockDatabase();

      await submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        sourceHash: '3'.repeat(64),
        idempotencyKey: 'idem_conflict_url_omitted',
      });

      // Second request switches to pdf without sourceUrl
      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'pdf',
          sourceHash: '3'.repeat(64),
          idempotencyKey: 'idem_conflict_url_omitted',
        }),
      ).rejects.toMatchObject({
        code: 'idempotency_conflict',
        status: 409,
      });
    });

    it('rejects URL submission targeting loopback and metadata endpoints with ssrf_destination_prohibited', async () => {
      const { client } = createMockDatabase();

      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'url',
          sourceUrl: 'http://169.254.169.254/latest/meta-data',
          idempotencyKey: 'idem_ssrf_1',
        }),
      ).rejects.toMatchObject({
        code: 'ssrf_destination_prohibited',
        status: 400,
      });

      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'url',
          sourceUrl: 'http://127.0.0.1/admin',
          idempotencyKey: 'idem_ssrf_2',
        }),
      ).rejects.toMatchObject({
        code: 'ssrf_destination_prohibited',
        status: 400,
      });

      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'url',
          sourceUrl: 'https://user:pass@example.com/menu',
          idempotencyKey: 'idem_ssrf_3',
        }),
      ).rejects.toMatchObject({
        code: 'ssrf_destination_prohibited',
        status: 400,
      });
    });
  });

  describe('MOCKED INTEGRATION TEST: Queue Event Handling and Duplicate Resilience', () => {
    it('safely ACKs duplicate queue message for an already completed job without re-execution', async () => {
      const { client, store } = createMockDatabase();

      // Submit and complete a job
      const job = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: 'f'.repeat(64),
        idempotencyKey: 'idem_queue_dup_1',
      });

      await executeIngestionWorkflow(client, {
        tenantId: venueId,
        jobId: job.id,
        workerId: 'worker_initial',
        extractor: async () => createStandardExtractionResult('pdf'),
      });

      expect(store.job?.status).toBe('complete');

      // Now process a duplicate queue message
      let ackCalled = false;
      let retryCalled = false;

      const mockMessage: QueueMessage = {
        body: {
          version: 1,
          tenantId: venueId,
          jobId: job.id,
          queuedAt: new Date().toISOString(),
        },
        attempts: 2,
        ack: () => {
          ackCalled = true;
        },
        retry: () => {
          retryCalled = true;
        },
      };

      const batch: QueueBatch = {
        messages: [mockMessage],
      };

      const extractorFn = vi.fn();
      await processIngestionQueueBatch(client, batch, extractorFn, {
        workerId: 'worker_duplicate_consumer',
      });

      expect(ackCalled).toBe(true);
      expect(retryCalled).toBe(false);
      expect(extractorFn).not.toHaveBeenCalled();
    });
  });
});

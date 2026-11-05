import type { MenuExtractionResult } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  executeIngestionWorkflow,
  processIngestionQueueBatch,
  type QueueMessage,
  submitMenuIngestion,
  validateIngestionUrl,
} from './orchestrator';
import { type DatabaseClient, IngestionError, type MenuIngestionJobRow } from './repository';

function createMockClient() {
  const store: {
    job?: MenuIngestionJobRow;
    drafts: any[];
  } = { drafts: [] };

  const client: DatabaseClient = {
    async query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number }> {
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
        store.job.attempt_count = (store.job.attempt_count ?? 0) + 1;
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

      if (text.includes('SELECT * FROM app_private.menu_ingestion_jobs')) {
        return { rows: store.job ? [store.job as unknown as R] : [], rowCount: store.job ? 1 : 0 };
      }

      if (text.includes('FOR UPDATE')) {
        return { rows: [{ lease_generation: '1' } as unknown as R], rowCount: 1 };
      }

      if (text.includes('INSERT INTO app_private.dish_drafts')) {
        store.drafts.push(values);
        return { rows: [], rowCount: 1 };
      }

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
        }
        return { rows: [], rowCount: 1 };
      }

      if (text.includes('SET status = CASE WHEN')) {
        if (store.job) {
          const isTerminal =
            values![6] === true || store.job.attempt_count >= store.job.max_attempts;
          store.job.status = isTerminal ? 'failed' : 'queued';
          store.job.error_code = values![0] as string;
          store.job.error_details = values![1] as string;
          store.job.result_storage_key =
            (values![2] as string | null) ?? store.job.result_storage_key;
          store.job.claim_token = null;
          store.job.locked_at = null;
          store.job.locked_by = null;
        }
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return { client, store };
}

describe('Ingestion Orchestrator', () => {
  const venueId = '00000000-0000-0000-0000-000000000501';

  it('submitMenuIngestion rejects unmaterialized url and text, rejects invalid/ssrf url, and enforces sourceHash on pdf/photo', async () => {
    const { client } = createMockClient();

    // Rejects unmaterialized url source
    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'idem_url_reject',
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_source_type',
      status: 400,
    });

    // Rejects url without sourceUrl
    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        idempotencyKey: 'idem_url_no_url',
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_source_type',
      status: 400,
    });

    // Validates url format and enforces SSRF defense via validateIngestionUrl
    expect(() => validateIngestionUrl('ftp://not-http-url')).toThrowError();
    expect(() => validateIngestionUrl('http://169.254.169.254/latest/meta-data')).toThrowError();
    expect(() => validateIngestionUrl('http://localhost/menu')).toThrowError();
    expect(() => validateIngestionUrl('https://user:pass@example.com/menu')).toThrowError();
    expect(() => validateIngestionUrl('https://example.com:8080/menu')).toThrowError();
    expect(validateIngestionUrl('https://example.com/menu').href).toBe('https://example.com/menu');

    // Rejects SSRF attempt through submitMenuIngestion directly
    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'http://169.254.169.254/latest/meta-data',
        idempotencyKey: 'idem_url_ssrf',
      }),
    ).rejects.toMatchObject({
      code: 'ssrf_destination_prohibited',
      status: 400,
    });

    // Accepts pdf with valid sourceHash
    const pdfJob = await submitMenuIngestion(client, {
      venueId,
      sourceType: 'pdf',
      sourceHash: 'a'.repeat(64),
      idempotencyKey: 'idem_pdf_accept',
    });
    expect(pdfJob.status).toBe('queued');
    expect(pdfJob.source_type).toBe('pdf');
    expect(pdfJob.source_hash).toBe('a'.repeat(64));
    expect(pdfJob.source_storage_key).toMatch(
      new RegExp(`^menu-ingestion/sources/${venueId}/[a-f0-9-]+/source$`),
    );

    // Accepts photo with valid sourceHash
    const photoJob = await submitMenuIngestion(client, {
      venueId,
      sourceType: 'photo',
      sourceHash: 'b'.repeat(64),
      idempotencyKey: 'idem_photo_accept',
    });
    expect(photoJob.status).toBe('queued');
    expect(photoJob.source_type).toBe('photo');
    expect(photoJob.source_hash).toBe('b'.repeat(64));

    // Rejects text
    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'text',
        idempotencyKey: 'idem_text_reject',
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_source_type',
      status: 400,
    });

    // Rejects pdf without sourceHash
    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        idempotencyKey: 'idem_missing_hash',
      }),
    ).rejects.toMatchObject({
      code: 'missing_source_hash',
      status: 400,
    });

    // Rejects invalid storage key
    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: '../malicious/path.pdf',
        idempotencyKey: 'idem_invalid_key',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_source_storage_key',
      status: 400,
    });

    // Rejects cross-tenant source storage key override
    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: 'menu-ingestion/sources/00000000-0000-0000-0000-000000000999/job/source',
        idempotencyKey: 'idem_cross_tenant_key',
      }),
    ).rejects.toMatchObject({
      code: 'unauthorized_source_storage_key',
      status: 400,
    });

    // Accepts valid pdf and derives canonical menu-ingestion sourceStorageKey when omitted
    const job = await submitMenuIngestion(client, {
      venueId,
      sourceType: 'pdf',
      sourceHash: 'b'.repeat(64),
      idempotencyKey: 'idem_valid_pdf',
    });

    expect(job.status).toBe('queued');
    expect(job.source_type).toBe('pdf');
    expect(job.source_hash).toBe('b'.repeat(64));
    expect(job.source_storage_key).toMatch(
      new RegExp(`^menu-ingestion/sources/${venueId}/[a-f0-9-]+/source$`),
    );
  });

  it('executeIngestionWorkflow coordinates successful extraction, adaptation, and persistence', async () => {
    const { client, store } = createMockClient();

    const job = await submitMenuIngestion(client, {
      venueId,
      sourceType: 'pdf',
      sourceHash: 'a'.repeat(64),
      sourceStorageKey: 'sources/sample.pdf',
      idempotencyKey: 'idem_flow_1',
    });

    const mockExtractor = async (): Promise<MenuExtractionResult> => ({
      schema_version: 1,
      pipeline_version: '2',
      status: 'complete',
      source: null,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:02.000Z',
      extraction_mode: 'layout',
      extraction_model: null,
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [
        {
          segment_id: 'seg_1',
          page_number: 1,
          method: 'html',
          status: 'ready',
          text: 'Margherita Pizza $14.50',
          native_text: null,
          error: null,
          warnings: [],
          metadata: {},
        },
      ],
      drafts: [
        {
          name: 'Margherita Pizza',
          description: null,
          category: 'Mains',
          price_amount: '14.50',
          price_currency: 'USD',
          ingredients: ['Tomato', 'Mozzarella'],
          source_id: 'src_1',
          source_text: 'Margherita Pizza $14.50',
          image_id: null,
          review_warnings: [],
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft_pizza_1',
          draft_index: 0,
          spans: [
            {
              segment_id: 'seg_1',
              start: 0,
              end: 23,
            },
          ],
        },
      ],
      capture_requests: [],
      warnings: [],
      errors: [],
    });

    const result = await executeIngestionWorkflow(client, {
      tenantId: venueId,
      jobId: job.id,
      workerId: 'worker_flow_1',
      extractor: mockExtractor,
    });

    expect(result.job.status).toBe('complete');
    expect(result.persistedCount).toBe(1);
    expect(result.drafts.length).toBe(1);
    expect(result.drafts[0]?.name).toBe('Margherita Pizza');
    expect(result.drafts[0]?.price_amount).toBe('14.50');
    expect(store.drafts.length).toBe(1);
  });

  it('executeIngestionWorkflow records failure when extractor returns status failed', async () => {
    const { client, store } = createMockClient();

    const job = await submitMenuIngestion(client, {
      venueId,
      sourceType: 'pdf',
      sourceHash: 'a'.repeat(64),
      sourceStorageKey: 'menus/sample.pdf',
      idempotencyKey: 'idem_flow_fail',
    });

    const failingExtractor = async (): Promise<MenuExtractionResult> => ({
      schema_version: 1,
      pipeline_version: '2',
      status: 'failed',
      source: null,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:02.000Z',
      extraction_mode: 'layout',
      extraction_model: null,
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [],
      drafts: [],
      evidence: [],
      capture_requests: [],
      warnings: ['OCR could not detect readable characters'],
      errors: ['Failed to parse PDF pages'],
    });

    const result = await executeIngestionWorkflow(client, {
      tenantId: venueId,
      jobId: job.id,
      workerId: 'worker_flow_2',
      extractor: failingExtractor,
    });

    expect(result.job.status).toBe('failed');
    expect(result.job.error_code).toBe('extraction_failed');
    expect(result.persistedCount).toBe(0);
  });

  describe('Cloudflare Queue integration', () => {
    const queueVenueId = '00000000-0000-4000-8000-000000000501';

    it('dispatches queue message on submission when queueProducer is provided', async () => {
      const { client } = createMockClient();
      const mockQueueProducer = {
        send: vi.fn().mockResolvedValue(undefined),
      };

      const job = await submitMenuIngestion(
        client,
        {
          venueId: queueVenueId,
          sourceType: 'pdf',
          sourceHash: 'a'.repeat(64),
          sourceStorageKey: 'sources/sample.pdf',
          idempotencyKey: 'idem_queue_prod_1',
        },
        mockQueueProducer,
      );

      expect(mockQueueProducer.send).toHaveBeenCalledTimes(1);
      expect(mockQueueProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
          tenantId: queueVenueId,
          jobId: job.id,
        }),
      );
    });

    it('throws queue_dispatch_failed if queueProducer fails', async () => {
      const { client } = createMockClient();
      const mockFailingProducer = {
        send: vi.fn().mockRejectedValue(new Error('Cloudflare Queue unavailable')),
      };

      await expect(
        submitMenuIngestion(
          client,
          {
            venueId: queueVenueId,
            sourceType: 'pdf',
            sourceHash: 'a'.repeat(64),
            sourceStorageKey: 'sources/sample.pdf',
            idempotencyKey: 'idem_queue_prod_fail',
          },
          mockFailingProducer,
        ),
      ).rejects.toThrow('Failed to enqueue ingestion job');
    });

    it('acknowledges poison messages to prevent infinite retry loops', async () => {
      const { client } = createMockClient();
      const poisonMsg: QueueMessage<unknown> = {
        id: 'msg_poison_1',
        body: { invalid: 'payload' },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processIngestionQueueBatch(client, { messages: [poisonMsg] }, vi.fn());

      expect(result.acknowledged).toBe(1);
      expect(result.retried).toBe(0);
      expect(poisonMsg.ack).toHaveBeenCalledTimes(1);
      expect(poisonMsg.retry).not.toHaveBeenCalled();
    });

    it('safely acknowledges duplicate delivery for already claimed or completed jobs', async () => {
      const { client } = createMockClient();
      // First submit and complete a job
      const job = await submitMenuIngestion(client, {
        venueId: queueVenueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: 'sources/sample.pdf',
        idempotencyKey: 'idem_dup_1',
      });

      const mockExtractor = vi.fn().mockResolvedValue({
        schema_version: 1,
        pipeline_version: '2',
        status: 'complete',
        source: null,
        started_at: '2026-10-24T12:00:00.000Z',
        finished_at: '2026-10-24T12:00:02.000Z',
        extraction_mode: 'layout',
        extraction_model: null,
        ocr_engine: 3,
        library_versions: {},
        configuration: {},
        segments: [],
        drafts: [],
        evidence: [],
        capture_requests: [],
        warnings: [],
        errors: [],
      });

      // Claim and complete once
      await executeIngestionWorkflow(client, {
        tenantId: queueVenueId,
        jobId: job.id,
        workerId: 'worker_primary',
        extractor: mockExtractor,
      });

      // Now simulate a duplicate queue delivery for the same job
      const duplicateMsg: QueueMessage<unknown> = {
        id: 'msg_dup_1',
        body: {
          version: 1,
          tenantId: queueVenueId,
          jobId: job.id,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processIngestionQueueBatch(
        client,
        { messages: [duplicateMsg] },
        mockExtractor,
      );

      expect(result.acknowledged).toBe(1);
      expect(result.retried).toBe(0);
      expect(duplicateMsg.ack).toHaveBeenCalledTimes(1);
      expect(duplicateMsg.retry).not.toHaveBeenCalled();
    });

    it('retries queue delivery when job is currently running under an active lease', async () => {
      const { client, store } = createMockClient();
      const job = await submitMenuIngestion(client, {
        venueId: queueVenueId,
        sourceType: 'pdf',
        sourceHash: 'b'.repeat(64),
        sourceStorageKey: 'sources/sample2.pdf',
        idempotencyKey: 'idem_active_lease_1',
      });

      // Manually set status to running with active lease
      store.job!.status = 'running';
      store.job!.claim_token = '00000000-0000-0000-0000-000000000111';
      store.job!.locked_at = new Date().toISOString();
      store.job!.locked_by = 'worker_busy';

      const mockExtractor = vi.fn();
      const activeMsg: QueueMessage<unknown> = {
        id: 'msg_active_1',
        body: {
          version: 1,
          tenantId: queueVenueId,
          jobId: job.id,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processIngestionQueueBatch(
        client,
        { messages: [activeMsg] },
        mockExtractor,
      );

      expect(result.acknowledged).toBe(0);
      expect(result.retried).toBe(1);
      expect(activeMsg.retry).toHaveBeenCalledTimes(1);
      expect(activeMsg.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) });
      const retryDelay = (activeMsg.retry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        ?.delaySeconds;
      expect(retryDelay).toBeGreaterThanOrEqual(900);
      expect(retryDelay).toBeLessThanOrEqual(901);
      expect(activeMsg.ack).not.toHaveBeenCalled();
      expect(mockExtractor).not.toHaveBeenCalled();
    });

    it('processes valid queue message, persists drafts, and acks message', async () => {
      const { client } = createMockClient();
      const job = await submitMenuIngestion(client, {
        venueId: queueVenueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: 'sources/sample.pdf',
        idempotencyKey: 'idem_valid_queue_1',
      });

      const mockExtractor = vi.fn().mockResolvedValue({
        schema_version: 1,
        pipeline_version: '2',
        status: 'complete',
        source: null,
        started_at: '2026-10-24T12:00:00.000Z',
        finished_at: '2026-10-24T12:00:02.000Z',
        extraction_mode: 'layout',
        extraction_model: null,
        ocr_engine: 3,
        library_versions: {},
        configuration: {},
        segments: [
          {
            segment_id: 'seg_q',
            page_number: 1,
            method: 'text',
            status: 'ready',
            text: 'Tacos — 12.00 USD',
            warnings: [],
          },
        ],
        drafts: [
          {
            name: 'Tacos',
            description: null,
            category: 'Mains',
            price_amount: '12.00',
            price_currency: 'USD',
            ingredients: [],
            source_id: 'src_doc_q',
            source_text: 'Tacos — 12.00 USD',
            image_id: null,
            review_warnings: [],
            status: 'needs_review',
          },
        ],
        evidence: [
          {
            draft_id: 'draft:q1',
            draft_index: 0,
            spans: [
              {
                segment_id: 'seg_q',
                start: 0,
                end: 17,
              },
            ],
          },
        ],
        capture_requests: [],
        warnings: [],
        errors: [],
      });

      const validMsg: QueueMessage<unknown> = {
        id: 'msg_valid_1',
        body: {
          version: 1,
          tenantId: queueVenueId,
          jobId: job.id,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processIngestionQueueBatch(
        client,
        { messages: [validMsg] },
        mockExtractor,
      );

      expect(result.processed).toBe(1);
      expect(result.acknowledged).toBe(1);
      expect(result.retried).toBe(0);
      expect(validMsg.ack).toHaveBeenCalledTimes(1);
      expect(validMsg.retry).not.toHaveBeenCalled();
    });

    it('retries queue delivery on transient extractor exceptions', async () => {
      const { client } = createMockClient();
      const job = await submitMenuIngestion(client, {
        venueId: queueVenueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: 'sources/sample.pdf',
        idempotencyKey: 'idem_transient_1',
      });

      const transientExtractor = vi
        .fn()
        .mockRejectedValue(new Error('Transient connection timeout'));

      const msg: QueueMessage<unknown> = {
        id: 'msg_transient_1',
        body: {
          version: 1,
          tenantId: queueVenueId,
          jobId: job.id,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processIngestionQueueBatch(
        client,
        { messages: [msg] },
        transientExtractor,
      );

      expect(result.retried).toBe(1);
      expect(result.acknowledged).toBe(0);
      expect(msg.retry).toHaveBeenCalledTimes(1);
      expect(msg.ack).not.toHaveBeenCalled();
    });

    it('retries queue delivery when extraction fails with retryable error and job resets to queued', async () => {
      const { client, store } = createMockClient();
      const job = await submitMenuIngestion(client, {
        venueId: queueVenueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: 'sources/sample.pdf',
        idempotencyKey: 'idem_retryable_status',
      });

      // Extractor returns failed status, but attempt_count is < max_attempts (job resets to 'queued')
      const failingExtractor = async (): Promise<MenuExtractionResult> => ({
        schema_version: 1,
        pipeline_version: '2',
        status: 'failed',
        source: null,
        started_at: '2026-10-27T10:00:00.000Z',
        finished_at: '2026-10-27T10:00:01.000Z',
        extraction_mode: 'layout',
        extraction_model: null,
        ocr_engine: 3,
        library_versions: {},
        configuration: {},
        segments: [],
        drafts: [],
        evidence: [],
        capture_requests: [],
        warnings: [],
        errors: ['OCR service temporary 503 error'],
      });

      // Override client query so failIngestionJob sets status to 'queued' (retryable)
      const originalQuery = client.query.bind(client);
      client.query = async (text: string, values?: unknown[]) => {
        if (text.includes('SET status = CASE WHEN')) {
          if (store.job) {
            store.job.status = 'queued'; // Requeued for retry
            store.job.error_code = values![0] as string;
            store.job.error_details = values![1] as string;
            store.job.claim_token = null;
          }
          return { rows: [], rowCount: 1 };
        }
        return originalQuery(text, values);
      };

      const msg: QueueMessage<unknown> = {
        id: 'msg_retryable_1',
        body: {
          version: 1,
          tenantId: queueVenueId,
          jobId: job.id,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processIngestionQueueBatch(
        client,
        { messages: [msg] },
        failingExtractor,
      );

      expect(result.retried).toBe(1);
      expect(result.acknowledged).toBe(0);
      expect(msg.retry).toHaveBeenCalledTimes(1);
      expect(msg.ack).not.toHaveBeenCalled();
    });
  });

  describe('Finding A: Durable Report and Timing Artifact Retention', () => {
    it('persists complete report artifact to storage and records result_storage_key on job', async () => {
      const { client, store } = createMockClient();
      const storageMap = new Map<string, string>();
      const mockStorage = {
        async put(key: string, data: string) {
          storageMap.set(key, data);
        },
        async get(key: string) {
          return storageMap.get(key) ?? null;
        },
      };

      const job = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: 'sources/sample.pdf',
        idempotencyKey: 'idem_finding_a_1',
      });

      const fullReport = {
        schema_version: 2,
        pipeline_version: '3',
        status: 'complete',
        source: {
          source_id: 'src_finding_a',
          sha256: 'a'.repeat(64),
          kind: 'website' as const,
          location: 'https://example.com/menu',
          retrieved_at: '2026-10-27T10:00:00.000Z',
          size_bytes: 1024,
          snapshot_base64: 'c29tZSBkYXRh',
        },
        started_at: '2026-10-27T10:00:00.000Z',
        finished_at: '2026-10-27T10:00:05.000Z',
        extraction_mode: 'ai' as const,
        configuration: {
          timings_seconds: { acquisition: 0.5, inference: 3.2 },
          llm_batches: [{ batch: 1, duration: 3.2 }],
        },
        segments: [
          {
            segment_id: 'seg_1',
            text: 'Special Pasta $18.00',
            status: 'ready' as const,
            method: 'text' as const,
            warnings: [],
            metadata: {},
          },
        ],
        drafts: [
          {
            draft_id: 'draft_pasta',
            name: 'Special Pasta',
            price_amount: '18.00',
            price_currency: 'USD',
            price_text: '$18.00',
            source_id: 'src_finding_a',
            source_text: 'Special Pasta $18.00',
            status: 'needs_review' as const,
            review_warnings: [],
          },
        ],
        evidence: [
          {
            draft_id: 'draft_pasta',
            draft_index: 0,
            spans: [{ segment_id: 'seg_1', start: 0, end: 20 }],
          },
        ],
        capture_requests: [],
        warnings: [],
        errors: [],
      };

      const outcome = await executeIngestionWorkflow(client, {
        tenantId: venueId,
        jobId: job.id,
        workerId: 'worker_storage_test',
        extractor: async () => fullReport,
        reportStorage: mockStorage,
      });

      expect(outcome.job.status).toBe('complete');
      const expectedStorageKey = `reports/${venueId}/${job.id}/attempts/00000000-0000-0000-0000-000000000999/extraction.json`;
      expect(outcome.job.result_storage_key).toBe(expectedStorageKey);

      // Verify artifact was durably written to storage
      const storedData = await mockStorage.get(expectedStorageKey);
      expect(storedData).not.toBeNull();
      const parsedStored = JSON.parse(storedData!);
      expect(parsedStored.configuration.timings_seconds.inference).toBe(3.2);

      // Verify sensitive timings are NOT leaked in returned structured drafts
      expect((outcome.drafts[0] as any).timings_seconds).toBeUndefined();
      expect((outcome.drafts[0] as any).llm_batches).toBeUndefined();
    });

    it('fails the job cleanly and does not report full success if report storage fails', async () => {
      const { client } = createMockClient();
      const failingStorage = {
        async put(_key: string, _data: string): Promise<void> {
          throw new Error('R2 write permission denied');
        },
      };

      const job = await submitMenuIngestion(client, {
        venueId,
        sourceType: 'pdf',
        sourceHash: 'a'.repeat(64),
        sourceStorageKey: 'sources/sample.pdf',
        idempotencyKey: 'idem_finding_a_fail',
      });

      await expect(
        executeIngestionWorkflow(client, {
          tenantId: venueId,
          jobId: job.id,
          workerId: 'worker_storage_fail',
          extractor: async () => ({
            schema_version: 1,
            pipeline_version: '2',
            status: 'complete',
            started_at: '2026-10-27T10:00:00.000Z',
            segments: [
              {
                segment_id: 'seg_1',
                text: 'Dish $10.00',
                status: 'ready',
                method: 'text',
                warnings: [],
                metadata: {},
              },
            ],
            drafts: [
              {
                name: 'Dish',
                source_id: 'src_1',
                source_text: 'Dish $10.00',
                status: 'needs_review',
                review_warnings: [],
              },
            ],
            evidence: [
              {
                draft_id: 'draft_1',
                draft_index: 0,
                spans: [{ segment_id: 'seg_1', start: 0, end: 11 }],
              },
            ],
            warnings: [],
            errors: [],
          }),
          reportStorage: failingStorage,
        }),
      ).rejects.toMatchObject({
        code: 'report_storage_failed',
      });
    });
  });

  describe('Review Fix: R2 Diagnostic Persistence & Retry Safety for Existing Unsupported-Source Jobs', () => {
    it('Test A — propagates R2 diagnostic write failure, does NOT ACK queue message, and leaves job non-terminal/re-queued', async () => {
      const { client, store } = createMockClient();
      const venueId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      store.job = {
        id: jobId,
        tenant_id: venueId,
        source_type: 'url',
        source_url: 'https://example.com/menu',
        source_hash: null,
        source_storage_key: null,
        result_storage_key: null,
        idempotency_key: 'idem_url_storage_fail',
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

      const failingStorage = {
        async put(_key: string, _data: string) {
          throw new Error('R2 write error: connection reset by peer');
        },
      };

      const extractor = async (job: MenuIngestionJobRow) => {
        if (job.source_type !== 'pdf' && job.source_type !== 'photo') {
          throw new IngestionError(
            'unsupported_extractor_source_type',
            400,
            `Python extraction service requires materialized 'pdf' or 'photo' source. Source type "${job.source_type}" must be processed via retrieval handoff or materialized prior to extraction.`,
          );
        }
        return {};
      };

      const msg: QueueMessage<unknown> = {
        id: 'msg_test_a',
        body: {
          version: 1,
          tenantId: venueId,
          jobId,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processIngestionQueueBatch(client, { messages: [msg] }, extractor, {
        workerId: 'worker_test_a',
        reportStorage: failingStorage,
      });

      // 1. Persistence error is propagated through queue consumer retry mechanism
      expect(result.retried).toBe(1);
      expect(result.acknowledged).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error).toContain('Failed to persist extraction report artifact');

      // 2. Queue message is NOT ACKed
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledTimes(1);

      // 3. Job is not incorrectly finalized as successfully handled (not 'failed')
      expect(store.job?.status).toBe('queued');
      expect(store.job?.error_code).toBe('report_storage_failed');

      // 4. Required archive persistence is not falsely reported as successful
      expect(store.job?.result_storage_key).toBeNull();
    });

    it('Test B — retries diagnostic persistence and ACKs only after required R2 persistence succeeds', async () => {
      const { client, store } = createMockClient();
      const venueId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      store.job = {
        id: jobId,
        tenant_id: venueId,
        source_type: 'url',
        source_url: 'https://example.com/menu',
        source_hash: null,
        source_storage_key: null,
        result_storage_key: null,
        idempotency_key: 'idem_url_retry_success',
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

      const storageMap = new Map<string, string>();
      let shouldFail = true;
      const flappyStorage = {
        async put(key: string, data: string) {
          if (shouldFail) {
            throw new Error('R2 write error: 503 Service Unavailable');
          }
          storageMap.set(key, data);
        },
      };

      const extractor = async (job: MenuIngestionJobRow) => {
        if (job.source_type !== 'pdf' && job.source_type !== 'photo') {
          throw new IngestionError(
            'unsupported_extractor_source_type',
            400,
            `Python extraction service requires materialized 'pdf' or 'photo' source. Source type "${job.source_type}" must be processed via retrieval handoff or materialized prior to extraction.`,
          );
        }
        return {};
      };

      // Attempt 1: R2 write fails
      const msg1: QueueMessage<unknown> = {
        id: 'msg_test_b_1',
        body: {
          version: 1,
          tenantId: venueId,
          jobId,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result1 = await processIngestionQueueBatch(client, { messages: [msg1] }, extractor, {
        workerId: 'worker_test_b_1',
        reportStorage: flappyStorage,
      });

      expect(result1.acknowledged).toBe(0);
      expect(result1.retried).toBe(1);
      expect(msg1.ack).not.toHaveBeenCalled();
      expect(msg1.retry).toHaveBeenCalledTimes(1);
      expect(store.job?.status).toBe('queued');
      expect(store.job?.result_storage_key).toBeNull();
      expect(storageMap.size).toBe(0);

      // Attempt 2: R2 write succeeds on retry
      shouldFail = false;
      const msg2: QueueMessage<unknown> = {
        id: 'msg_test_b_2',
        body: {
          version: 1,
          tenantId: venueId,
          jobId,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result2 = await processIngestionQueueBatch(client, { messages: [msg2] }, extractor, {
        workerId: 'worker_test_b_2',
        reportStorage: flappyStorage,
      });

      // Assertions
      expect(result2.acknowledged).toBe(1);
      expect(result2.retried).toBe(0);
      expect(msg2.ack).toHaveBeenCalledTimes(1);
      expect(msg2.retry).not.toHaveBeenCalled();

      // Diagnostic record is eventually persisted
      expect(store.job?.result_storage_key).not.toBeNull();
      expect(storageMap.has(store.job!.result_storage_key!)).toBe(true);

      const persistedDiagnostic = JSON.parse(storageMap.get(store.job!.result_storage_key!)!);
      expect(persistedDiagnostic.status).toBe('failed');
      expect(persistedDiagnostic.errors[0]).toContain(
        'Source type "url" must be processed via retrieval handoff',
      );

      // Existing unsupported-source business outcome is preserved
      expect(store.job?.status).toBe('failed');
      expect(store.job?.error_code).toBe('unsupported_extractor_source_type');
    });

    it('Test C — retrying persistence is deterministic, overwriting identical attempt key without duplicate or corrupted archives', async () => {
      const { client, store } = createMockClient();
      const venueId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      store.job = {
        id: jobId,
        tenant_id: venueId,
        source_type: 'url',
        source_url: 'https://example.com/menu',
        source_hash: null,
        source_storage_key: null,
        result_storage_key: null,
        idempotency_key: 'idem_url_idempotency',
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

      const storageMap = new Map<string, string>();
      const putCounts = new Map<string, number>();
      const spyStorage = {
        async put(key: string, data: string) {
          putCounts.set(key, (putCounts.get(key) ?? 0) + 1);
          storageMap.set(key, data);
        },
      };

      const extractor = async (job: MenuIngestionJobRow) => {
        if (job.source_type !== 'pdf' && job.source_type !== 'photo') {
          throw new IngestionError(
            'unsupported_extractor_source_type',
            400,
            `Python extraction service requires materialized 'pdf' or 'photo' source. Source type "${job.source_type}" must be processed via retrieval handoff or materialized prior to extraction.`,
          );
        }
        return {};
      };

      const msg1: QueueMessage<unknown> = {
        id: 'msg_test_c_1',
        body: {
          version: 1,
          tenantId: venueId,
          jobId,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result1 = await processIngestionQueueBatch(client, { messages: [msg1] }, extractor, {
        workerId: 'worker_test_c_1',
        reportStorage: spyStorage,
      });

      expect(result1.acknowledged).toBe(1);
      expect(msg1.ack).toHaveBeenCalledTimes(1);
      const canonicalKey = store.job!.result_storage_key!;
      expect(canonicalKey).toBeTruthy();
      expect(putCounts.get(canonicalKey)).toBe(1);

      // Duplicate delivery for already terminal job: ACKs safely without re-writing or corrupting archive
      const msg2: QueueMessage<unknown> = {
        id: 'msg_test_c_2',
        body: {
          version: 1,
          tenantId: venueId,
          jobId,
          queuedAt: new Date().toISOString(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result2 = await processIngestionQueueBatch(client, { messages: [msg2] }, extractor, {
        workerId: 'worker_test_c_2',
        reportStorage: spyStorage,
      });

      expect(result2.acknowledged).toBe(1);
      expect(msg2.ack).toHaveBeenCalledTimes(1);
      // No duplicate put was performed for completed job
      expect(putCounts.get(canonicalKey)).toBe(1);
      expect(storageMap.size).toBe(1);
    });

    it('Test D — regression protection preserves raw URL rejection, box evidence, failed-report archival, and lease expiry', async () => {
      const { client, store } = createMockClient();
      const venueId = crypto.randomUUID();
      const jobId = crypto.randomUUID();

      // 1. Raw URL rejection at intake boundary
      await expect(
        submitMenuIngestion(client, {
          venueId,
          sourceType: 'url',
          sourceUrl: 'https://example.com/menu',
          idempotencyKey: 'idem_regression_url',
        }),
      ).rejects.toMatchObject({
        code: 'unsupported_source_type',
        status: 400,
      });

      // 2. Failed-report archival failure propagates and does not ACK
      store.job = {
        id: jobId,
        tenant_id: venueId,
        source_type: 'pdf',
        source_hash: 'c'.repeat(64),
        source_storage_key: 'sources/test.pdf',
        source_url: null,
        result_storage_key: null,
        idempotency_key: 'idem_regression_fail_diag',
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

      const failingStorage = {
        async put(_key: string, _data: string) {
          throw new Error('R2 write error');
        },
      };

      await expect(
        executeIngestionWorkflow(client, {
          tenantId: venueId,
          jobId,
          workerId: 'worker_regression_fail',
          extractor: async () => ({
            schema_version: 1,
            pipeline_version: '2',
            status: 'failed',
            source: null,
            started_at: '2026-10-27T10:00:00.000Z',
            finished_at: '2026-10-27T10:00:01.000Z',
            extraction_mode: 'layout',
            segments: [],
            drafts: [],
            evidence: [],
            capture_requests: [],
            warnings: [],
            errors: ['Model failed'],
          }),
          reportStorage: failingStorage,
        }),
      ).rejects.toMatchObject({
        code: 'report_storage_failed',
      });
    });

    it('Test E — exhausts retries on continuous R2 archive failure, transitions job to failed, and routes redelivery to recovery/DLQ without silent ACK', async () => {
      const { client, store } = createMockClient();
      const venueId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      store.job = {
        id: jobId,
        tenant_id: venueId,
        source_type: 'pdf',
        source_url: null,
        source_hash: 'f'.repeat(64),
        source_storage_key: `menu-ingestion/sources/${venueId}/${jobId}/source`,
        result_storage_key: null,
        idempotency_key: 'idem_r2_exhaustion_test',
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

      const storageMap = new Map<string, string>();
      const failingStorage = {
        async put(_key: string, _data: string) {
          throw new Error('R2 write error: 500 Internal Server Error');
        },
        async get(key: string) {
          return storageMap.get(key) ?? null;
        },
      };

      const extractor = async () => ({
        schema_version: 1,
        pipeline_version: '2',
        status: 'complete',
        source: null,
        started_at: '2026-10-24T12:00:00.000Z',
        finished_at: '2026-10-24T12:00:02.000Z',
        extraction_mode: 'layout',
        segments: [],
        drafts: [
          {
            name: 'Pancakes',
            description: null,
            category: 'Breakfast',
            price_amount: '10.00',
            price_currency: 'USD',
            ingredients: [],
            source_id: 'src_1',
            source_text: 'Pancakes $10.00',
            image_id: null,
            review_warnings: [],
            status: 'needs_review' as const,
          },
        ],
        evidence: [],
        capture_requests: [],
        warnings: [],
        errors: [],
      });

      // Attempt 1: Initial delivery, R2 archive fails, job retries
      const msg1: QueueMessage<unknown> = {
        id: 'msg_exhaust_1',
        body: { version: 1, tenantId: venueId, jobId, queuedAt: new Date().toISOString() },
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const res1 = await processIngestionQueueBatch(client, { messages: [msg1] }, extractor, {
        workerId: 'worker_exhaust_1',
        reportStorage: failingStorage,
      });
      expect(res1.acknowledged).toBe(0);
      expect(res1.retried).toBe(1);
      expect(msg1.ack).not.toHaveBeenCalled();
      expect(msg1.retry).toHaveBeenCalledTimes(1);
      expect(store.job?.status).toBe('queued');
      expect(store.job?.attempt_count).toBe(1);
      expect(store.job?.result_storage_key).toBeNull();
      expect(storageMap.size).toBe(0);

      // Attempt 2: Second delivery, R2 archive fails again, job retries
      const msg2: QueueMessage<unknown> = {
        id: 'msg_exhaust_2',
        body: { version: 1, tenantId: venueId, jobId, queuedAt: new Date().toISOString() },
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const res2 = await processIngestionQueueBatch(client, { messages: [msg2] }, extractor, {
        workerId: 'worker_exhaust_2',
        reportStorage: failingStorage,
      });
      expect(res2.acknowledged).toBe(0);
      expect(res2.retried).toBe(1);
      expect(msg2.ack).not.toHaveBeenCalled();
      expect(msg2.retry).toHaveBeenCalledTimes(1);
      expect(store.job?.status).toBe('queued');
      expect(store.job?.attempt_count).toBe(2);
      expect(store.job?.result_storage_key).toBeNull();

      // Attempt 3: Max attempts reached (3 of 3), R2 archive fails, job transitions to terminal 'failed'
      const msg3: QueueMessage<unknown> = {
        id: 'msg_exhaust_3',
        body: { version: 1, tenantId: venueId, jobId, queuedAt: new Date().toISOString() },
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const res3 = await processIngestionQueueBatch(client, { messages: [msg3] }, extractor, {
        workerId: 'worker_exhaust_3',
        reportStorage: failingStorage,
      });
      expect(res3.acknowledged).toBe(0);
      expect(res3.retried).toBe(1);
      expect(msg3.ack).not.toHaveBeenCalled();
      expect(msg3.retry).toHaveBeenCalledTimes(1);
      expect(store.job?.status).toBe('failed');
      expect(store.job?.attempt_count).toBe(3);
      expect(store.job?.error_code).toBe('report_storage_failed');
      expect(store.job?.result_storage_key).toBeNull();

      // Subsequent delivery (Attempt 4): Consumer sees exhausted/failed state without required archive
      // Invariant: Must NOT silently ACK! Must route to retry/recovery toward DLQ!
      const msg4: QueueMessage<unknown> = {
        id: 'msg_exhaust_4',
        body: { version: 1, tenantId: venueId, jobId, queuedAt: new Date().toISOString() },
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const res4 = await processIngestionQueueBatch(client, { messages: [msg4] }, extractor, {
        workerId: 'worker_exhaust_4',
        reportStorage: failingStorage,
      });
      expect(res4.acknowledged).toBe(0);
      expect(res4.retried).toBe(1);
      expect(msg4.ack).not.toHaveBeenCalled();
      expect(msg4.retry).toHaveBeenCalledTimes(1);
      expect(res4.errors).toHaveLength(1);
      expect(res4.errors[0]?.error).toContain('Failed to persist extraction report artifact');

      // Final state invariant check: no false "archived successfully" state
      expect(store.job?.status).toBe('failed');
      expect(store.job?.attempt_count).toBe(3);
      expect(store.job?.result_storage_key).toBeNull();
      expect(storageMap.size).toBe(0);
    });
  });
});

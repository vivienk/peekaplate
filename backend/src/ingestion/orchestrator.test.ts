import type { MenuExtractionResult } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  executeIngestionWorkflow,
  processIngestionQueueBatch,
  type QueueMessage,
  submitMenuIngestion,
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
          store.job.claim_token = null;
          store.job.locked_at = null;
        }
        return { rows: [], rowCount: 1 };
      }

      if (text.includes('SET status = CASE WHEN attempt_count >= max_attempts')) {
        if (store.job) {
          store.job.status = 'failed';
          store.job.error_code = values![0] as string;
          store.job.error_details = values![1] as string;
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

  it('submitMenuIngestion validates URLs and protocol', async () => {
    const { client } = createMockClient();

    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'ftp://example.com/menu',
        idempotencyKey: 'idem_1',
      }),
    ).rejects.toThrow(IngestionError);

    await expect(
      submitMenuIngestion(client, {
        venueId,
        sourceType: 'url',
        sourceUrl: 'not-a-valid-url',
        idempotencyKey: 'idem_2',
      }),
    ).rejects.toThrow(IngestionError);

    const job = await submitMenuIngestion(client, {
      venueId,
      sourceType: 'url',
      sourceUrl: 'https://restaurant.example.com/menu',
      idempotencyKey: 'idem_3',
    });

    expect(job.status).toBe('queued');
    expect(job.source_type).toBe('url');
  });

  it('executeIngestionWorkflow coordinates successful extraction, adaptation, and persistence', async () => {
    const { client, store } = createMockClient();

    const job = await submitMenuIngestion(client, {
      venueId,
      sourceType: 'url',
      sourceUrl: 'https://restaurant.example.com/menu',
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
          sourceType: 'url',
          sourceUrl: 'https://example.com/menu',
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
            sourceType: 'url',
            sourceUrl: 'https://example.com/menu',
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
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
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

    it('processes valid queue message, persists drafts, and acks message', async () => {
      const { client } = createMockClient();
      const job = await submitMenuIngestion(client, {
        venueId: queueVenueId,
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
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
                end: 5,
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
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
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
  });
});

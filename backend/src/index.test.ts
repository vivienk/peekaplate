import { describe, expect, it, vi } from 'vitest';
import app, { createApp, handleQueueBatch } from './index';

describe('foundation API', () => {
  it('returns a minimal liveness response without database or secret configuration', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'peekaplate-api',
      stage: 'foundation',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('does not expose an unimplemented event ingestion endpoint', async () => {
    const response = await app.request('/events', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
  it('rejects an unauthenticated dish revision before accessing the database', async () => {
    const response = await app.request(
      '/venues/00000000-0000-4000-8000-000000000001/dishes/00000000-0000-4000-8000-000000000002/revisions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('dish HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const dishId = '00000000-0000-4000-8000-000000000002';
  const actorId = '00000000-0000-4000-8000-000000000003';
  const command = {
    commandId: crypto.randomUUID(),
    expectedVersion: 0,
    name: 'Soup',
    description: '',
  };
  const path = `/venues/${venueId}/dishes/${dishId}/revisions`;
  it('derives actor from verification and passes validated content to the transaction', async () => {
    const result = {
      dishId,
      revisionId: crypto.randomUUID(),
      version: 1,
      name: 'Soup',
      description: '',
    };
    const execute = vi.fn().mockResolvedValue(result);
    const verify = vi.fn().mockResolvedValue(actorId);
    const response = await createApp({ verify, execute }).request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(execute).toHaveBeenCalledWith(actorId, venueId, { ...command, dishId }, {});
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('rejects malformed JSON, forged authority, wrong media type and oversized bodies before writing', async () => {
    const execute = vi.fn();
    const testApp = createApp({ verify: async () => actorId, execute });
    for (const [body, contentType, status] of [
      ['{', 'application/json', 400],
      [JSON.stringify({ ...command, actorId }), 'application/json', 400],
      [JSON.stringify(command), 'text/plain', 415],
      ['x'.repeat(16_385), 'application/json', 413],
    ] as const) {
      const response = await testApp.request(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': contentType },
        body,
      });
      expect(response.status).toBe(status);
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('fails closed when hosted authentication is unconfigured', async () => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
});

describe('menu ingestion HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const jobId = '00000000-0000-4000-8000-000000000002';
  const draftId = '00000000-0000-4000-8000-000000000003';
  const actorId = '00000000-0000-4000-8000-000000000004';

  it('submits a menu ingestion job when authenticated and authorized', async () => {
    const mockJob = {
      id: jobId,
      tenant_id: venueId,
      source_type: 'url',
      source_url: 'https://example.com/menu',
      idempotency_key: 'idem_post_1',
      status: 'queued',
    };
    const submitIngestion = vi.fn().mockResolvedValue(mockJob);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      submitIngestion,
    });

    const response = await testApp.request(`/venues/${venueId}/menus/jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'idem_post_1',
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ job: mockJob });
    expect(submitIngestion).toHaveBeenCalledWith(
      actorId,
      venueId,
      {
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'idem_post_1',
      },
      {},
    );
  });

  it('retrieves an ingestion job status by ID', async () => {
    const mockJob = {
      id: jobId,
      tenant_id: venueId,
      status: 'complete',
      draft_count: 5,
    };
    const getIngestionJob = vi.fn().mockResolvedValue(mockJob);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      getIngestionJob,
    });

    const response = await testApp.request(`/venues/${venueId}/menus/jobs/${jobId}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid_token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: mockJob });
    expect(getIngestionJob).toHaveBeenCalledWith(actorId, venueId, jobId, {});
  });

  it('lists dish drafts for review', async () => {
    const mockDrafts = [
      {
        id: draftId,
        tenant_id: venueId,
        name: 'Soup',
        review_status: 'pending',
      },
    ];
    const listDrafts = vi.fn().mockResolvedValue(mockDrafts);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      listDrafts,
    });

    const response = await testApp.request(`/venues/${venueId}/drafts?status=pending`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid_token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drafts: mockDrafts });
    expect(listDrafts).toHaveBeenCalledWith(
      actorId,
      venueId,
      { status: 'pending', jobId: undefined },
      {},
    );
  });

  it('approves a dish draft and promotes to published revision', async () => {
    const mockResult = {
      draft: {
        id: draftId,
        review_status: 'accepted',
        published_dish_id: '00000000-0000-4000-8000-000000000005',
      },
      publishedRevision: {
        dishId: '00000000-0000-4000-8000-000000000005',
        revisionId: '00000000-0000-4000-8000-000000000006',
        version: 1,
        name: 'Soup',
        description: 'Warm soup',
      },
    };
    const approveDraft = vi.fn().mockResolvedValue(mockResult);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      approveDraft,
    });

    const commandId = '00000000-0000-4000-8000-000000000007';
    const response = await testApp.request(`/venues/${venueId}/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        expectedVersion: 0,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(mockResult);
    expect(approveDraft).toHaveBeenCalledWith(
      actorId,
      venueId,
      draftId,
      { commandId, expectedVersion: 0 },
      {},
    );
  });

  it('rejects malformed nonempty JSON on approval with 400 invalid_json without executing command', async () => {
    const venueId = '00000000-0000-4000-8000-000000000001';
    const draftId = '00000000-0000-4000-8000-000000000002';
    const actorId = '00000000-0000-4000-8000-000000000003';
    const approveDraft = vi.fn();
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      approveDraft,
    });

    const response = await testApp.request(`/venues/${venueId}/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: '{"commandId":',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it('rejects approval request without required commandId with 400 invalid_request', async () => {
    const venueId = '00000000-0000-4000-8000-000000000001';
    const draftId = '00000000-0000-4000-8000-000000000002';
    const actorId = '00000000-0000-4000-8000-000000000003';
    const approveDraft = vi.fn();
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      approveDraft,
    });

    const response = await testApp.request(`/venues/${venueId}/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(approveDraft).not.toHaveBeenCalled();
  });

  describe('Cloudflare Queue Worker Handler', () => {
    it('retries all messages when database connection string is unavailable', async () => {
      const msg1 = { ack: vi.fn(), retry: vi.fn() };
      const msg2 = { ack: vi.fn(), retry: vi.fn() };

      await handleQueueBatch(
        { messages: [msg1, msg2] as any },
        { APP_ENV: 'local' }, // no LOCAL_DATABASE_URL or HYPERDRIVE
      );

      expect(msg1.retry).toHaveBeenCalledTimes(1);
      expect(msg2.retry).toHaveBeenCalledTimes(1);
      expect(msg1.ack).not.toHaveBeenCalled();
      expect(msg2.ack).not.toHaveBeenCalled();
    });

    it('connects INGESTION_REPORTS_BUCKET to reportStorage and passes leaseTimeoutMinutes 15', async () => {
      const mockPut = vi.fn().mockResolvedValue(undefined);
      const mockBucket = { put: mockPut };
      const msg = { ack: vi.fn(), retry: vi.fn() };
      const mockProcessBatch = vi
        .fn()
        .mockImplementation(async (_client, _batch, _extractor, options) => {
          expect(options.leaseTimeoutMinutes).toBe(15);
          expect(options.reportStorage).toBeDefined();
          // Invoke put to verify bucket wiring
          await options.reportStorage.put('reports/t1/j1/extraction.json', '{"test":true}');
        });

      // Provide mock database URL to pass the initial connection check
      // Mock Client connection
      const mockEnv = {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
        INGESTION_REPORTS_BUCKET: mockBucket,
      };

      // Mock Client prototype
      const { Client } = await import('pg');
      const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined as any);
      const endSpy = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as any);

      try {
        await handleQueueBatch({ messages: [msg as any] }, mockEnv, {
          verify: vi.fn(),
          execute: vi.fn(),
          processQueueBatch: mockProcessBatch,
        });

        expect(mockProcessBatch).toHaveBeenCalledTimes(1);
        expect(mockPut).toHaveBeenCalledWith('reports/t1/j1/extraction.json', '{"test":true}');
      } finally {
        connectSpy.mockRestore();
        endSpy.mockRestore();
      }
    });

    it('retries queue message when report storage throws before completion/ACK', async () => {
      const msg = { ack: vi.fn(), retry: vi.fn() };
      const mockFailingProcessBatch = vi.fn().mockImplementation(async () => {
        throw new Error('R2 write failed: INGESTION_REPORTS_BUCKET unavailable');
      });

      const mockEnv = {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
        INGESTION_REPORTS_BUCKET: { put: vi.fn().mockRejectedValue(new Error('R2 write failed')) },
      };

      const { Client } = await import('pg');
      const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined as any);
      const endSpy = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as any);

      try {
        await handleQueueBatch({ messages: [msg as any] }, mockEnv, {
          verify: vi.fn(),
          execute: vi.fn(),
          processQueueBatch: mockFailingProcessBatch,
        });

        expect(msg.retry).toHaveBeenCalledTimes(1);
        expect(msg.ack).not.toHaveBeenCalled();
      } finally {
        connectSpy.mockRestore();
        endSpy.mockRestore();
      }
    });
  });
});

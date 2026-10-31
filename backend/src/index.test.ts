import { describe, expect, it, vi } from 'vitest';
import app, { createApp, createWorker, queue } from './index';

describe('worker queue consumer wiring', () => {
  it('exports queue handler on default app and as named export', () => {
    expect(typeof queue).toBe('function');
    expect(typeof (app as any).queue).toBe('function');
    expect((app as any).queue).toBe(queue);
  });

  it('safely handles queue invocation when archive bucket binding is missing', async () => {
    let retried = false;
    let delay: number | undefined;
    const batch = {
      queue: 'peekaplate-staging-observations',
      messages: [
        {
          id: 'msg-1',
          timestamp: new Date(),
          body: { test: true },
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
      ackAll: vi.fn(),
      retryAll: vi.fn((opts?: { delaySeconds?: number }) => {
        retried = true;
        delay = opts?.delaySeconds;
      }),
    };

    await (app as any).queue(batch, { APP_ENV: 'staging' });
    expect(retried).toBe(true);
    expect(delay).toBe(10);
  });

  it('delegates to injected queue consumer service through createWorker', async () => {
    let processBatchCalled = false;
    let cleanupCalled = false;

    const worker = createWorker(
      { verify: vi.fn(), execute: vi.fn() },
      {
        createConsumer: async () => ({
          consumer: {
            processBatch: async () => {
              processBatchCalled = true;
              return { processed: 1, acknowledged: 1, retried: 0, deadLettered: 0 };
            },
          } as any,
          cleanup: async () => {
            cleanupCalled = true;
          },
        }),
      },
    );

    const batch = {
      queue: 'peekaplate-staging-observations',
      messages: [],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    await worker.queue(batch, {});
    expect(processBatchCalled).toBe(true);
    expect(cleanupCalled).toBe(true);
  });
});

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

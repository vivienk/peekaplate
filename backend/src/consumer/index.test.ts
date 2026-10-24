import { describe, expect, it } from 'vitest';
import { FakeObservationRepository } from './database';
import { createQueueHandler } from './index';
import { type MessageBatch, QueueConsumer, type QueueMessage } from './queue-consumer';
import { FakeR2ArchiveStorage } from './r2-storage';

class TestQueueMessage implements QueueMessage<unknown> {
  public acked = false;
  public retried = false;
  public retryDelay?: number | undefined;

  constructor(
    public readonly id: string,
    public readonly body: unknown,
    public readonly attempts = 1,
    public readonly timestamp = new Date(),
  ) {}

  ack(): void {
    this.acked = true;
  }

  retry(options?: { delaySeconds?: number }): void {
    this.retried = true;
    this.retryDelay = options?.delaySeconds;
  }
}

class TestMessageBatch implements MessageBatch<unknown> {
  public allAcked = false;
  public allRetried = false;
  public retryDelay?: number | undefined;

  constructor(
    public readonly queue: string,
    public readonly messages: TestQueueMessage[],
  ) {}

  ackAll(): void {
    this.allAcked = true;
    for (const m of this.messages) m.ack();
  }

  retryAll(options?: { delaySeconds?: number }): void {
    this.allRetried = true;
    this.retryDelay = options?.delaySeconds;
    for (const m of this.messages) m.retry(options);
  }
}

describe('createQueueHandler', () => {
  it('retries all messages with a safety delay if OBSERVATION_ARCHIVE_BUCKET binding is missing', async () => {
    const handler = createQueueHandler();
    const msg = new TestQueueMessage('m1', { venueId: 'v1', eventId: 'e1' });
    const batch = new TestMessageBatch('obs-queue', [msg]);

    await handler(batch, { APP_ENV: 'local', LOCAL_DATABASE_URL: 'postgres://localhost/test' });

    expect(batch.allRetried).toBe(true);
    expect(batch.retryDelay).toBe(10);
    expect(msg.retried).toBe(true);
  });

  it('retries all messages with a safety delay if database connection configuration is missing', async () => {
    const handler = createQueueHandler();
    const msg = new TestQueueMessage('m1', { venueId: 'v1', eventId: 'e1' });
    const batch = new TestMessageBatch('obs-queue', [msg]);

    const fakeBucket = new FakeR2ArchiveStorage();
    await handler(batch, { APP_ENV: 'local', OBSERVATION_ARCHIVE_BUCKET: fakeBucket as any });

    expect(batch.allRetried).toBe(true);
    expect(batch.retryDelay).toBe(10);
    expect(msg.retried).toBe(true);
  });

  it('delegates to injected consumer and executes lifecycle cleanup', async () => {
    const r2Storage = new FakeR2ArchiveStorage();
    const repository = new FakeObservationRepository();
    const consumer = new QueueConsumer({ r2Storage, repository });
    let cleanupCalled = false;

    const handler = createQueueHandler({
      createConsumer: async () => ({
        consumer,
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
    });

    const msg = new TestQueueMessage('m1', {
      venueId: 'v-adapter',
      eventId: 'e-adapter',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
      payload: { test: true },
    });
    const batch = new TestMessageBatch('obs-queue', [msg]);

    await handler(batch, {});

    expect(msg.acked).toBe(true);
    expect(cleanupCalled).toBe(true);
    expect(repository.index.size).toBe(1);
    expect(r2Storage.has('raw/observations/v-adapter/2026/10/24/e-adapter.json')).toBe(true);
  });
});

import { Client } from 'pg';
import { PostgresObservationRepository } from './database';
import { type MessageBatch, QueueConsumer, type QueueConsumerDependencies } from './queue-consumer';
import { CloudflareR2Storage, type R2BucketLike } from './r2-storage';

export type ConsumerBindings = {
  APP_ENV?: string;
  LOCAL_DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  OBSERVATION_ARCHIVE_BUCKET?: R2BucketLike;
};

export type QueueHandlerServices = {
  createConsumer?: (env: ConsumerBindings) => Promise<{
    consumer: QueueConsumer;
    cleanup?: () => Promise<void>;
  }>;
};

/**
 * Creates a Cloudflare Workers Queue handler adapting incoming MessageBatch
 * events to the QueueConsumer processing engine.
 *
 * Follows the repository's dependency injection and client lifecycle patterns:
 * - Uses Hyperdrive in staging/production, LOCAL_DATABASE_URL in local dev.
 * - Manages Client connection lifecycle with cleanup.
 * - Allows full service injection for unit and integration testing.
 */
export function createQueueHandler(services: QueueHandlerServices = {}) {
  return async function queue(batch: MessageBatch<unknown>, env: ConsumerBindings): Promise<void> {
    if (services.createConsumer) {
      const { consumer, cleanup } = await services.createConsumer(env);
      try {
        await consumer.processBatch(batch);
      } finally {
        if (cleanup) await cleanup();
      }
      return;
    }

    // Default runtime resolution
    if (!env.OBSERVATION_ARCHIVE_BUCKET) {
      console.error(
        JSON.stringify({
          event: 'queue_consumer_error',
          error: 'OBSERVATION_ARCHIVE_BUCKET binding is missing',
        }),
      );
      // Mark all messages for retry since required infrastructure is missing
      batch.retryAll({ delaySeconds: 10 });
      return;
    }

    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;

    if (!connectionString) {
      console.error(
        JSON.stringify({
          event: 'queue_consumer_error',
          error: 'Database connection configuration is missing',
        }),
      );
      batch.retryAll({ delaySeconds: 10 });
      return;
    }

    const r2Storage = new CloudflareR2Storage(env.OBSERVATION_ARCHIVE_BUCKET);
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });

    try {
      await client.connect();
      const repository = new PostgresObservationRepository(client);
      const consumer = new QueueConsumer({
        r2Storage,
        repository,
        log: (level, msg, meta) => {
          if (level === 'error') {
            console.error(JSON.stringify({ event: 'queue_consumer_log', level, msg, ...meta }));
          }
        },
      });

      await consumer.processBatch(batch);
    } catch (err: unknown) {
      console.error(
        JSON.stringify({
          event: 'queue_consumer_batch_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // If unhandled error occurs outside per-message processing, retry batch
      batch.retryAll({ delaySeconds: 10 });
    } finally {
      try {
        await client.end();
      } catch {
        // ignore client close errors
      }
    }
  };
}

export default createQueueHandler();

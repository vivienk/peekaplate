import {
  canonicalJson,
  ObservationQueueMessageSchema,
  sha256,
  toCanonicalObservation,
} from '@peekaplate/contracts';
import { Client } from 'pg';
import { PostgresObservationRepository } from './database';
import { QueueConsumer } from './queue-consumer';
import { CloudflareR2Storage, type R2BucketLike } from './r2-storage';
import { buildRawArchiveKey, type R2ArchiveStorage } from './types';

/** Operator-only, bounded recovery. Missing facts are durable work; no sequence cursor or public route. */
export async function pendingObservationFacts(client: Client, tenantId: string, limit = 100) {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid backfill scope');
  }
  let rows: { event_id: string; r2_archive_key: string; checksum: string }[];
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `SELECT i.event_id, i.r2_archive_key, i.canonical_payload_checksum AS checksum
       FROM app_private.observation_index i
       WHERE i.tenant_id=$1 AND i.disposition='accepted'
         AND NOT EXISTS (SELECT 1 FROM app_private.observation_event e
                         WHERE e.tenant_id=i.tenant_id AND e.event_id=i.event_id)
       ORDER BY i.first_received_at, i.event_id LIMIT $2`,
      [tenantId, limit],
    );
    rows = result.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return rows;
}

export async function backfillObservationFacts(
  client: Client,
  storage: R2ArchiveStorage,
  tenantId: string,
  limit = 100,
) {
  const rows = await pendingObservationFacts(client, tenantId, limit);
  const consumer = new QueueConsumer({
    r2Storage: storage,
    repository: new PostgresObservationRepository(client),
  });
  const results: { eventId: string; status: 'restored' | 'blocked' }[] = [];
  for (const row of rows) {
    try {
      if (row.r2_archive_key !== buildRawArchiveKey(tenantId, row.event_id))
        throw new Error('Unexpected archive key');
      const archive = await storage.getRawPayload(row.r2_archive_key);
      if (!archive || archive.checksum !== row.checksum) throw new Error('Archive unavailable');
      const raw = JSON.parse(new TextDecoder().decode(archive.rawBytes));
      // Historic missing classification is unresolved provenance, never permission to count it as live.
      if (!Object.hasOwn(raw, 'traffic_class')) throw new Error('Missing trusted traffic class');
      const envelope = ObservationQueueMessageSchema.parse(raw);
      if (
        envelope.tenantId !== tenantId ||
        envelope.eventId !== row.event_id ||
        (await sha256(canonicalJson(toCanonicalObservation(envelope)))) !== row.checksum
      ) {
        throw new Error('Archive identity mismatch');
      }
      const outcome = await consumer.processMessage(envelope);
      results.push({
        eventId: row.event_id,
        status: outcome.status === 'acknowledged' ? 'restored' : 'blocked',
      });
    } catch {
      results.push({ eventId: row.event_id, status: 'blocked' });
    }
  }
  return results;
}

// Entrypoint for the loopback operator runner only; never mounted in the API Worker.
export default {
  async fetch(
    request: Request,
    env: {
      APP_ENV: string;
      BACKFILL_SECRET: string;
      BACKFILL_TENANT: string;
      HYPERDRIVE: { connectionString: string };
      OBSERVATION_ARCHIVE_BUCKET: R2BucketLike;
    },
  ) {
    if (
      env.APP_ENV !== 'staging' ||
      !env.BACKFILL_SECRET ||
      request.headers.get('x-backfill-secret') !== env.BACKFILL_SECRET
    )
      return new Response(null, { status: 404 });
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405 });
    const client = new Client({
      connectionString: env.HYPERDRIVE.connectionString,
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      const result =
        request.method === 'GET'
          ? await pendingObservationFacts(client, env.BACKFILL_TENANT)
          : await backfillObservationFacts(
              client,
              new CloudflareR2Storage(env.OBSERVATION_ARCHIVE_BUCKET),
              env.BACKFILL_TENANT,
            );
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'backfill_unavailable' }, { status: 503 });
    } finally {
      await client.end();
    }
  },
};

import { beforeEach, describe, expect, it } from 'vitest';
import { FakeObservationRepository } from './database';
import {
  type MessageBatch,
  QueueConsumer,
  type QueueMessage,
  validateConflictObservationEnvelope,
  validateObservationEnvelope,
  validateQueueEnvelope,
} from './queue-consumer';
import { FakeR2ArchiveStorage } from './r2-storage';
import { buildConflictArchiveKey, buildRawArchiveKey } from './types';

class FakeQueueMessage implements QueueMessage<unknown> {
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

class FakeMessageBatch implements MessageBatch<unknown> {
  constructor(
    public readonly queue: string,
    public readonly messages: FakeQueueMessage[],
  ) {}

  ackAll(): void {
    for (const m of this.messages) m.ack();
  }

  retryAll(options?: { delaySeconds?: number }): void {
    for (const m of this.messages) m.retry(options);
  }
}

const T1 = '11111111-1111-4111-8111-111111111111';
const E1 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';

describe('validateObservationEnvelope', () => {
  it('validates a correct envelope with string observation.v2, UUIDs, and preserves sessionId', () => {
    const valid = {
      tenantId: T1,
      eventId: E1,
      sessionId: 'sess-789',
      schemaVersion: 'observation.v2',
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_detail_opened',
      payload: { dishId: 'd-1' },
    };
    const parsed = validateObservationEnvelope(valid);
    expect(parsed.tenantId).toBe(T1);
    expect(parsed.eventId).toBe(E1);
    expect(parsed.authorizedPublicationId).toBe(P1);
    expect(parsed.sessionId).toBe('sess-789');
    expect(parsed.schemaVersion).toBe('observation.v2');
    expect(parsed.type).toBe('dish_detail_opened');
  });

  it('rejects browser-facing snake_case formats at the queue envelope boundary', () => {
    const snake = {
      tenant_id: T1,
      event_id: E1,
      authorized_publication_id: P1,
      session_id: 'sess-snake',
      schema_version: 'observation.v2',
      occurred_at: '2026-10-24T12:00:00Z',
      event_type: 'menu_viewed',
    };
    expect(() => validateObservationEnvelope(snake)).toThrow(/Missing or invalid tenantId/);
  });

  it('rejects malformed envelopes with missing or non-UUID fields', () => {
    expect(() => validateObservationEnvelope(null)).toThrow('Message body must be an object');
    expect(() => validateObservationEnvelope({})).toThrow('Missing or invalid tenantId');
    expect(() => validateObservationEnvelope({ tenantId: 'not-a-uuid' })).toThrow(
      'Missing or invalid tenantId',
    );
    expect(() => validateObservationEnvelope({ tenantId: T1 })).toThrow(
      'Missing or invalid eventId',
    );
    expect(() => validateObservationEnvelope({ tenantId: T1, eventId: E1 })).toThrow(
      'Missing or invalid authorizedPublicationId',
    );
  });

  it('rejects legacy numeric schema version or unknown string schema version', () => {
    expect(() =>
      validateObservationEnvelope({
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        schemaVersion: 2,
        occurredAt: '2026-10-24T12:00:00Z',
        type: 'dish_viewed',
      }),
    ).toThrow(/Unsupported schemaVersion: expected 'observation.v2'/);

    expect(() =>
      validateObservationEnvelope({
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        schemaVersion: 'observation.v1',
        occurredAt: '2026-10-24T12:00:00Z',
        type: 'dish_viewed',
      }),
    ).toThrow(/Unsupported schemaVersion: expected 'observation.v2'/);
  });

  it('rejects unsupported event types', () => {
    expect(() =>
      validateObservationEnvelope({
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        schemaVersion: 'observation.v2',
        occurredAt: '2026-10-24T12:00:00Z',
        type: 'non_existent_event_type',
      }),
    ).toThrow(/Unsupported observation type: non_existent_event_type/);
  });
});

describe('validateConflictObservationEnvelope and validateQueueEnvelope', () => {
  it('validates a valid observation_conflict.v1 envelope with payload', () => {
    const raw = {
      kind: 'observation_conflict.v1',
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      sessionId: 'sess-conflict',
      occurredAt: '2026-10-24T12:00:00Z',
      firstReceivedAt: '2026-10-24T12:00:01Z',
      type: 'dish_viewed',
      incomingChecksum: 'a'.repeat(64),
      conflictReason: 'event_id_conflict',
      payload: { step: 'conflict' },
    };

    const parsed = validateQueueEnvelope(raw);
    expect(parsed.kind).toBe('observation_conflict.v1');
    expect(parsed.tenantId).toBe(T1);
    expect(parsed.eventId).toBe(E1);
    expect(parsed.authorizedPublicationId).toBe(P1);
    expect((parsed as any).payload).toEqual({ step: 'conflict' });
    expect((parsed as any).incomingChecksum).toBe('a'.repeat(64));
  });

  it('validates an observation_conflict.v1 envelope with bounded metadata', () => {
    const raw = {
      kind: 'observation_conflict.v1',
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T12:00:00Z',
      incomingChecksum: 'b'.repeat(64),
      conflictReason: 'payload_too_large',
      boundedMetadata: { size: 35000, reasonCode: 'payload_too_large' },
    };

    const parsed = validateQueueEnvelope(raw);
    expect(parsed.kind).toBe('observation_conflict.v1');
    expect(parsed.tenantId).toBe(T1);
    expect(parsed.eventId).toBe(E1);
    expect((parsed as any).incomingChecksum).toBe('b'.repeat(64));
    expect((parsed as any).boundedMetadata).toEqual({
      size: 35000,
      reasonCode: 'payload_too_large',
    });
  });

  it('rejects malformed conflict envelopes with missing or non-UUID fields', () => {
    expect(() =>
      validateConflictObservationEnvelope({
        kind: 'observation_conflict.v1',
        tenantId: 'bad-uuid',
        eventId: E1,
        authorizedPublicationId: P1,
      }),
    ).toThrow(/Missing or invalid tenantId: must be a valid UUID/);

    expect(() =>
      validateConflictObservationEnvelope({
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: 'bad-uuid',
        authorizedPublicationId: P1,
      }),
    ).toThrow(/Missing or invalid eventId: must be a valid UUID/);

    expect(() =>
      validateConflictObservationEnvelope({
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: 'bad-uuid',
      }),
    ).toThrow(/Missing or invalid authorizedPublicationId: must be a valid UUID/);

    expect(() =>
      validateConflictObservationEnvelope({
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        incomingChecksum: 'not-64-hex',
      }),
    ).toThrow(/Invalid incomingChecksum: must be a 64-character hex string/);
  });

  it('correctly discriminates normal observation.v2 vs conflict observation_conflict.v1 envelopes', () => {
    const normal = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_viewed',
      payload: { normal: true },
    };
    const conflict = {
      kind: 'observation_conflict.v1',
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T12:00:00Z',
      payload: { conflict: true },
    };

    const parsedNormal = validateQueueEnvelope(normal);
    const parsedConflict = validateQueueEnvelope(conflict);

    expect(parsedNormal.kind).toBe('observation.v2');
    expect(parsedConflict.kind).toBe('observation_conflict.v1');
  });
});

describe('QueueConsumer', () => {
  let r2Storage: FakeR2ArchiveStorage;
  let repository: FakeObservationRepository;
  let consumer: QueueConsumer;

  beforeEach(() => {
    r2Storage = new FakeR2ArchiveStorage();
    repository = new FakeObservationRepository();
    consumer = new QueueConsumer({ r2Storage, repository });
  });

  it('Case A: First delivery archives raw payload to R2, persists canonical DB record, and acknowledges', async () => {
    const msg = {
      tenantId: T1,
      eventId: E1,
      schemaVersion: 'observation.v2',
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_detail_opened',
      payload: { dishId: 'dish-1', section: 'starters' },
    };

    const disposition = await consumer.processMessage(msg);
    expect(disposition.status).toBe('acknowledged');
    if (disposition.status === 'acknowledged') {
      expect(disposition.reason).toBe('persisted');
    }

    // Verify R2 archival occurred first with expected key
    const expectedKey = `raw/observations/${T1}/2026/10/24/${E1}.json`;
    expect(r2Storage.has(expectedKey)).toBe(true);
    expect(r2Storage.putCalls.length).toBe(1);
    expect(r2Storage.putCalls[0]!.key).toBe(expectedKey);

    // Verify database canonical record exists
    const dbRecord = await repository.lookupExisting(T1, E1);
    expect(dbRecord).not.toBeNull();
    expect(dbRecord?.disposition).toBe('accepted');
  });

  it('Case B: Same event ID and same content acknowledged as duplicate without duplicate row or error', async () => {
    const msg = {
      tenantId: T1,
      eventId: E1,
      schemaVersion: 'observation.v2',
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_viewed',
      payload: { dishId: 'dish-1', tier: 'T1' },
    };

    // First delivery
    const d1 = await consumer.processMessage(msg);
    expect(d1.status).toBe('acknowledged');

    // Second delivery (duplicate retry)
    const d2 = await consumer.processMessage(msg);
    expect(d2.status).toBe('acknowledged');
    if (d2.status === 'acknowledged') {
      expect(d2.reason).toBe('duplicate_same_payload');
    }

    // Repository still has exactly one record
    expect(repository.index.size).toBe(1);
    expect(repository.conflicts.size).toBe(0);
  });

  it('Case C: Same event ID with different content is quarantined in conflict table with distinct R2 key', async () => {
    const originalMsg = {
      tenantId: T1,
      eventId: E1,
      schemaVersion: 'observation.v2',
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_detail_opened',
      payload: { dishId: 'dish-1', details: 'original' },
    };

    const conflictingMsg = {
      tenantId: T1,
      eventId: E1,
      schemaVersion: 'observation.v2',
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_detail_opened',
      payload: { dishId: 'dish-1', details: 'tampered-or-different' },
    };

    // Process original
    const d1 = await consumer.processMessage(originalMsg);
    expect(d1.status).toBe('acknowledged');

    // Process conflicting message
    const d2 = await consumer.processMessage(conflictingMsg);
    expect(d2.status).toBe('acknowledged');
    if (d2.status === 'acknowledged') {
      expect(d2.reason).toBe('conflict_recorded');
    }

    // Original canonical record unchanged
    const stored = await repository.lookupExisting(T1, E1);
    expect(stored).not.toBeNull();

    // Conflict table has the quarantined discrepancy
    expect(repository.conflicts.size).toBe(1);
    const conflictRecord = Array.from(repository.conflicts.values())[0]!;
    expect(conflictRecord.eventId).toBe(E1);
    expect(conflictRecord.tenantId).toBe(T1);

    // Verify distinct conflict key stored in R2
    expect(r2Storage.has(conflictRecord.r2ArchiveKey)).toBe(true);
    expect(conflictRecord.r2ArchiveKey).toContain(conflictRecord.incomingChecksum);
  });

  it('Case D: Transient R2 failure returns retry and does not write to database', async () => {
    const msg = {
      tenantId: T1,
      eventId: E1,
      schemaVersion: 'observation.v2',
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_viewed',
      payload: { dishId: 'dish-1' },
    };

    r2Storage.failNextPut = true;

    const disposition = await consumer.processMessage(msg);
    expect(disposition.status).toBe('retry');

    // Database must not have been reached
    const dbRecord = await repository.lookupExisting(T1, E1);
    expect(dbRecord).toBeNull();
  });

  it('Case D2: Transient database failure after R2 archival returns retry and allows safe replay', async () => {
    const msg = {
      tenantId: T1,
      eventId: E1,
      schemaVersion: 'observation.v2',
      authorizedPublicationId: P1,
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_viewed',
      payload: { dishId: 'dish-1' },
    };

    // DB fails on first try
    repository.failNextPersist = true;

    const d1 = await consumer.processMessage(msg);
    expect(d1.status).toBe('retry');

    // R2 archive already created
    const expectedKey = `raw/observations/${T1}/2026/10/24/${E1}.json`;
    expect(r2Storage.has(expectedKey)).toBe(true);

    // DB was not persisted
    expect(await repository.lookupExisting(T1, E1)).toBeNull();

    // On retry, R2 sees existing key without error, and DB write succeeds
    const d2 = await consumer.processMessage(msg);
    expect(d2.status).toBe('acknowledged');
    expect(await repository.lookupExisting(T1, E1)).not.toBeNull();
  });

  it('Case E: Malformed message returns dead_letter disposition', async () => {
    const malformed = {
      tenantId: T1,
      // Missing eventId
      type: 'dish_viewed',
    };

    const disposition = await consumer.processMessage(malformed);
    expect(disposition.status).toBe('dead_letter');
  });

  it('Case F: Partial batch failure handles messages independently', async () => {
    const e2 = '22222222-2222-4222-8222-222222222202';
    const e3 = '22222222-2222-4222-8222-222222222203';
    const e4 = '22222222-2222-4222-8222-222222222204';

    const validMsg1 = new FakeQueueMessage('msg-1', {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'menu_viewed',
      payload: { step: 1 },
    });

    const malformedMsg = new FakeQueueMessage('msg-2', {
      tenantId: T1,
      // missing eventId
      type: 'menu_viewed',
    });

    const transientFailMsg = new FakeQueueMessage('msg-3', {
      tenantId: T1,
      eventId: e3,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'menu_viewed',
      payload: { step: 3 },
    });

    const validMsg4 = new FakeQueueMessage('msg-4', {
      tenantId: T1,
      eventId: e4,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'menu_viewed',
      payload: { step: 4 },
    });

    const batch = new FakeMessageBatch('observations-queue', [
      validMsg1,
      malformedMsg,
      transientFailMsg,
      validMsg4,
    ]);

    // Make msg-3 fail on DB (specifically targeting e3)
    repository.failOnEventId = e3;

    const result = await consumer.processBatch(batch);

    expect(result.processed).toBe(4);
    expect(result.acknowledged).toBe(2); // msg-1 and msg-4 (durable successes only)
    expect(result.retried).toBe(2); // msg-2 (malformed -> retry toward DLQ) and msg-3 (transient DB failure)
    expect(result.deadLettered).toBe(1); // msg-2

    expect(validMsg1.acked).toBe(true);
    expect(validMsg1.retried).toBe(false);

    // Malformed message must NOT be prematurely acknowledged before reaching DLQ
    expect(malformedMsg.acked).toBe(false);
    expect(malformedMsg.retried).toBe(true);

    expect(transientFailMsg.acked).toBe(false);
    expect(transientFailMsg.retried).toBe(true);

    expect(validMsg4.acked).toBe(true);
    expect(validMsg4.retried).toBe(false);
  });

  it('Operation ordering: asserts R2 archival precedes database persistence precedes message ack', async () => {
    const traceLog: string[] = [];
    const tracingConsumer = new QueueConsumer({
      r2Storage,
      repository,
      onTrace: (op) => traceLog.push(op),
    });

    const msg = new FakeQueueMessage('msg-order', {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T12:00:00Z',
      firstReceivedAt: '2026-10-24T12:00:00Z',
      type: 'dish_viewed',
      payload: { dishId: 'd-ord' },
    });
    const batch = new FakeMessageBatch('q-order', [msg]);

    await tracingConsumer.processBatch(batch);

    expect(traceLog).toEqual(['r2.put', 'db.persistCanonical', 'msg.ack']);
    expect(msg.acked).toBe(true);
  });

  it('R2 mismatching checksum on existing key is quarantined as conflict with distinct conflict key', async () => {
    // Seed R2 with existing archive for this event with a different checksum
    const existingKey = `raw/observations/${T1}/2026/10/24/${E1}.json`;
    r2Storage.setExisting(
      existingKey,
      new TextEncoder().encode(JSON.stringify({ step: 'original-payload' })),
      'orig-checksum-1111111111111111111111111111111111111111111111111111111111111111',
    );

    const conflictingIncomingMsg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_viewed',
      payload: { step: 'tampered-payload' },
    };

    const disposition = await consumer.processMessage(conflictingIncomingMsg);
    expect(disposition.status).toBe('acknowledged');
    if (disposition.status === 'acknowledged') {
      expect(disposition.reason).toBe('conflict_recorded');
    }

    // Must NOT have created a canonical row in observation_index
    const dbRecord = await repository.lookupExisting(T1, E1);
    expect(dbRecord).toBeNull();

    // Must have recorded in observation_conflict
    expect(repository.conflicts.size).toBe(1);
    const conflictRecord = Array.from(repository.conflicts.values())[0]!;
    expect(conflictRecord.r2ArchiveKey.includes(conflictRecord.incomingChecksum)).toBe(true);
    expect(r2Storage.has(conflictRecord.r2ArchiveKey)).toBe(true);
  });

  it('Conflict record persistence failure returns retry disposition to prevent data loss', async () => {
    const originalMsg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_viewed',
      payload: { val: 1 },
    };

    await consumer.processMessage(originalMsg);

    const conflictingMsg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_viewed',
      payload: { val: 999 },
    };

    repository.failNextRecordConflict = true;

    const disposition = await consumer.processMessage(conflictingMsg);
    expect(disposition.status).toBe('retry');
    if (disposition.status === 'retry') {
      expect(disposition.error.message).toContain('Conflict table insertion failed');
    }

    // On retry, conflict recording succeeds and is acknowledged
    const d2 = await consumer.processMessage(conflictingMsg);
    expect(d2.status).toBe('acknowledged');
    if (d2.status === 'acknowledged') {
      expect(d2.reason).toBe('conflict_recorded');
    }
  });

  it('Duplicate conflict redelivery is recognized as already recorded and ACKed safely without infinite retry', async () => {
    const originalMsg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_saved',
      payload: { orig: true },
    };

    await consumer.processMessage(originalMsg);

    const conflictingMsg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T10:00:00Z',
      firstReceivedAt: '2026-10-24T10:00:00Z',
      type: 'dish_saved',
      payload: { conflict: true },
    };

    // First delivery of conflict
    const d1 = await consumer.processMessage(conflictingMsg);
    expect(d1.status).toBe('acknowledged');
    expect((d1 as { reason: string }).reason).toBe('conflict_recorded');

    // Redelivery of same conflict
    const d2 = await consumer.processMessage(conflictingMsg);
    expect(d2.status).toBe('acknowledged');
    expect((d2 as { reason: string }).reason).toBe('duplicate_same_payload');

    expect(repository.conflicts.size).toBe(1);
  });

  it('Archive key security: rejects path traversal attempts in tenantId and eventId', async () => {
    expect(() => buildRawArchiveKey('../../etc/passwd', E1, '2026-10-24T10:00:00Z')).toThrow(
      /Invalid tenantId for archive key/,
    );
    expect(() => buildRawArchiveKey(T1, '../sub/path', '2026-10-24T10:00:00Z')).toThrow(
      /Invalid eventId for archive key/,
    );
    expect(() =>
      buildConflictArchiveKey(T1, E1, '2026-10-24T10:00:00Z', 'not-a-64-char-hex-checksum'),
    ).toThrow(/Invalid checksum for conflict archive key/);
  });

  it('Concurrent processing of identical payloads resolves deterministically to exactly one canonical row', async () => {
    const msg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T12:00:00Z',
      firstReceivedAt: '2026-10-24T12:00:00Z',
      type: 'dish_viewed',
      payload: { concurrent: true },
    };

    const [res1, res2] = await Promise.all([
      consumer.processMessage(msg),
      consumer.processMessage(msg),
    ]);

    expect(res1.status).toBe('acknowledged');
    expect(res2.status).toBe('acknowledged');

    const reasons = [
      (res1 as { reason: string }).reason,
      (res2 as { reason: string }).reason,
    ].sort();
    expect(reasons).toEqual(['duplicate_same_payload', 'persisted']);
    expect(repository.index.size).toBe(1);
    expect(repository.conflicts.size).toBe(0);
  });

  it('Concurrent processing of conflicting payloads creates one canonical row and one quarantined conflict', async () => {
    const msgA = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T12:00:00Z',
      firstReceivedAt: '2026-10-24T12:00:00Z',
      type: 'dish_viewed',
      payload: { branch: 'A' },
    };

    const msgB = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T12:00:00Z',
      firstReceivedAt: '2026-10-24T12:00:00Z',
      type: 'dish_viewed',
      payload: { branch: 'B' },
    };

    const [resA, resB] = await Promise.all([
      consumer.processMessage(msgA),
      consumer.processMessage(msgB),
    ]);

    expect(resA.status).toBe('acknowledged');
    expect(resB.status).toBe('acknowledged');

    const reasons = [
      (resA as { reason: string }).reason,
      (resB as { reason: string }).reason,
    ].sort();
    expect(reasons).toEqual(['conflict_recorded', 'persisted']);

    expect(repository.index.size).toBe(1);
    expect(repository.conflicts.size).toBe(1);
  });

  it('Repeated 5x identical deliveries: exactly 1 canonical record, 0 conflicts, all acknowledged safely', async () => {
    const msg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T12:00:00Z',
      firstReceivedAt: '2026-10-24T12:00:00Z',
      type: 'dish_viewed',
      payload: { attempts: 5 },
    };

    for (let i = 1; i <= 5; i++) {
      const disposition = await consumer.processMessage(msg);
      expect(disposition.status).toBe('acknowledged');
      if (i === 1) {
        expect((disposition as { reason: string }).reason).toBe('persisted');
      } else {
        expect((disposition as { reason: string }).reason).toBe('duplicate_same_payload');
      }
    }

    expect(repository.index.size).toBe(1);
    expect(repository.conflicts.size).toBe(0);
  });

  it('Repeated conflicting deliveries: original canonical row remains intact, all distinct conflicts recorded', async () => {
    const canonicalMsg = {
      tenantId: T1,
      eventId: E1,
      authorizedPublicationId: P1,
      schemaVersion: 'observation.v2',
      occurredAt: '2026-10-24T12:00:00Z',
      firstReceivedAt: '2026-10-24T12:00:00Z',
      type: 'dish_viewed',
      payload: { canonical: true },
    };

    await consumer.processMessage(canonicalMsg);

    for (let i = 1; i <= 3; i++) {
      const conflictingMsg = {
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        schemaVersion: 'observation.v2',
        occurredAt: '2026-10-24T12:00:00Z',
        firstReceivedAt: '2026-10-24T12:00:00Z',
        type: 'dish_viewed',
        payload: { mutation: i },
      };
      const disposition = await consumer.processMessage(conflictingMsg);
      expect(disposition.status).toBe('acknowledged');
      expect((disposition as { reason: string }).reason).toBe('conflict_recorded');
    }

    // Original row preserved unchanged
    const canonical = await repository.lookupExisting(T1, E1);
    expect(canonical).not.toBeNull();
    expect(repository.index.size).toBe(1);
    // All 3 conflicts captured
    expect(repository.conflicts.size).toBe(3);
  });

  describe('observation_conflict.v1 processing', () => {
    it('processes a valid observation_conflict.v1 message by archiving to conflict key and persisting to conflict table', async () => {
      const conflictMsg = {
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        occurredAt: '2026-10-24T12:00:00Z',
        firstReceivedAt: '2026-10-24T12:00:00Z',
        type: 'dish_viewed',
        conflictReason: 'event_id_conflict',
        payload: { item: 'conflict-payload' },
      };

      const disposition = await consumer.processMessage(conflictMsg);
      expect(disposition.status).toBe('acknowledged');
      expect((disposition as { reason: string }).reason).toBe('conflict_recorded');

      // Canonical index must remain untouched
      expect(repository.index.size).toBe(0);
      // Conflict must be recorded
      expect(repository.conflicts.size).toBe(1);
      const conflictRecord = Array.from(repository.conflicts.values())[0]!;
      expect(conflictRecord.tenantId).toBe(T1);
      expect(conflictRecord.eventId).toBe(E1);
      expect(conflictRecord.r2ArchiveKey).toContain(conflictRecord.incomingChecksum);
      expect(r2Storage.has(conflictRecord.r2ArchiveKey)).toBe(true);
    });

    it('processes an observation_conflict.v1 message with bounded metadata (invalid copy)', async () => {
      const boundedChecksum = 'd'.repeat(64);
      const boundedMsg = {
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        occurredAt: '2026-10-24T12:00:00Z',
        firstReceivedAt: '2026-10-24T12:00:00Z',
        incomingChecksum: boundedChecksum,
        conflictReason: 'schema_invalid',
        boundedMetadata: { reason: 'schema_invalid', errorField: 'missing_type' },
      };

      const disposition = await consumer.processMessage(boundedMsg);
      expect(disposition.status).toBe('acknowledged');
      expect((disposition as { reason: string }).reason).toBe('conflict_recorded');

      expect(repository.index.size).toBe(0);
      expect(repository.conflicts.size).toBe(1);
      const conflictRecord = Array.from(repository.conflicts.values())[0]!;
      expect(conflictRecord.incomingChecksum).toBe(boundedChecksum);
      expect(r2Storage.has(conflictRecord.r2ArchiveKey)).toBe(true);
    });

    it('handles idempotent redelivery of observation_conflict.v1 safely', async () => {
      const conflictMsg = {
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        occurredAt: '2026-10-24T12:00:00Z',
        firstReceivedAt: '2026-10-24T12:00:00Z',
        payload: { item: 'conflict-idempotent' },
      };

      // First delivery
      const d1 = await consumer.processMessage(conflictMsg);
      expect(d1.status).toBe('acknowledged');
      expect((d1 as { reason: string }).reason).toBe('conflict_recorded');

      // Second delivery (identical retry)
      const d2 = await consumer.processMessage(conflictMsg);
      expect(d2.status).toBe('acknowledged');
      expect((d2 as { reason: string }).reason).toBe('duplicate_same_payload');

      expect(repository.conflicts.size).toBe(1);
    });

    it('retries on transient R2 failure during observation_conflict.v1 and does not acknowledge', async () => {
      r2Storage.failNextPut = true;

      const conflictMsg = {
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        occurredAt: '2026-10-24T12:00:00Z',
        payload: { item: 'fail-r2' },
      };

      const disposition = await consumer.processMessage(conflictMsg);
      expect(disposition.status).toBe('retry');
      expect(repository.conflicts.size).toBe(0);
    });

    it('retries on transient DB failure during observation_conflict.v1 and preserves R2 archive', async () => {
      repository.failNextRecordConflict = true;

      const conflictMsg = {
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        occurredAt: '2026-10-24T12:00:00Z',
        payload: { item: 'fail-db' },
      };

      const disposition = await consumer.processMessage(conflictMsg);
      expect(disposition.status).toBe('retry');
      expect(repository.conflicts.size).toBe(0);

      // On retry, archival detects existing key and DB persist succeeds
      const d2 = await consumer.processMessage(conflictMsg);
      expect(d2.status).toBe('acknowledged');
      expect(repository.conflicts.size).toBe(1);
    });

    it('processes a batch with mixed observation.v2 and observation_conflict.v1 messages', async () => {
      const eNormal = '55555555-5555-4555-8555-555555555555';
      const eConflict = '66666666-6666-4666-8666-666666666666';

      const normalMsg = new FakeQueueMessage('msg-norm', {
        kind: 'observation.v2',
        tenantId: T1,
        eventId: eNormal,
        authorizedPublicationId: P1,
        schemaVersion: 'observation.v2',
        occurredAt: '2026-10-24T12:00:00Z',
        firstReceivedAt: '2026-10-24T12:00:00Z',
        type: 'dish_viewed',
        payload: { dish: 'norm' },
      });

      const conflictMsg = new FakeQueueMessage('msg-conf', {
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: eConflict,
        authorizedPublicationId: P1,
        occurredAt: '2026-10-24T12:00:00Z',
        payload: { dish: 'conf' },
      });

      const batch = new FakeMessageBatch('q-mixed', [normalMsg, conflictMsg]);
      const result = await consumer.processBatch(batch);

      expect(result.processed).toBe(2);
      expect(result.acknowledged).toBe(2);
      expect(result.retried).toBe(0);
      expect(normalMsg.acked).toBe(true);
      expect(conflictMsg.acked).toBe(true);

      expect(repository.index.size).toBe(1);
      expect(repository.conflicts.size).toBe(1);
    });

    it('reproduces and prevents the critical failure scenario: normal parser rejects conflict envelope while queue consumer safely handles it', async () => {
      const validConflict = {
        kind: 'observation_conflict.v1' as const,
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        occurredAt: '2026-10-24T12:00:00Z',
        incomingChecksum: 'c'.repeat(64),
        conflictReason: 'event_id_conflict',
        payload: { conflict: true },
      };

      // Defect verification: calling normal-event parser on a valid conflict envelope throws MalformedMessageError
      expect(() => validateObservationEnvelope(validConflict)).toThrow(
        /Unsupported envelope kind|Malformed observation.v2 envelope|Unsupported schemaVersion/,
      );

      // Correction verification: validateQueueEnvelope correctly validates the conflict variant
      const parsed = validateQueueEnvelope(validConflict);
      expect(parsed.kind).toBe('observation_conflict.v1');

      // Full processing verification: processMessage archives evidence and persists to DB before acknowledging
      const msg = new FakeQueueMessage('msg-conflict-regression', validConflict);
      const batch = new FakeMessageBatch('obs-queue', [msg]);

      const result = await consumer.processBatch(batch);

      // Message is acknowledged ONLY after durable archival and DB persistence
      expect(result.processed).toBe(1);
      expect(result.acknowledged).toBe(1);
      expect(result.deadLettered).toBe(0);
      expect(msg.acked).toBe(true);

      // Durable outcome verification:
      expect(repository.conflicts.size).toBe(1);
      const conflictRow = Array.from(repository.conflicts.values())[0]!;
      expect(conflictRow.tenantId).toBe(T1);
      expect(conflictRow.eventId).toBe(E1);
      expect(r2Storage.has(conflictRow.r2ArchiveKey)).toBe(true);
    });

    it('processes multi-copy observation_conflict.v1 envelopes matching S3-DATA-01 producer format', async () => {
      const checksumA = 'a'.repeat(64);
      const checksumB = 'b'.repeat(64);

      const producerConflictMsg = {
        kind: 'observation_conflict.v1' as const,
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        firstReceivedAt: '2026-10-24T12:00:00Z',
        reasonCode: 'event_id_conflict',
        copies: [
          {
            validation: 'valid' as const,
            canonicalChecksum: checksumA,
            event: { step: 'copy-1' },
          },
          {
            validation: 'invalid' as const,
            canonicalChecksum: checksumB,
            metadata: { reason: 'copy-2' },
          },
        ],
      };

      const msg = new FakeQueueMessage('msg-producer-conflict', producerConflictMsg);
      const batch = new FakeMessageBatch('obs-queue', [msg]);

      const result = await consumer.processBatch(batch);

      expect(result.processed).toBe(1);
      expect(result.acknowledged).toBe(1);
      expect(msg.acked).toBe(true);

      // Both copies are recorded in PostgreSQL conflict table
      expect(repository.conflicts.size).toBe(2);
      expect(repository.conflicts.has(`${T1}:${E1}:${checksumA}`)).toBe(true);
      expect(repository.conflicts.has(`${T1}:${E1}:${checksumB}`)).toBe(true);
    });
  });
});

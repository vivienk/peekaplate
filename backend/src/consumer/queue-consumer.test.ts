import { beforeEach, describe, expect, it } from 'vitest';
import { FakeObservationRepository } from './database';
import {
  type MessageBatch,
  QueueConsumer,
  type QueueMessage,
  validateObservationEnvelope,
} from './queue-consumer';
import { FakeR2ArchiveStorage } from './r2-storage';

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

describe('validateObservationEnvelope', () => {
  it('validates a correct envelope with camelCase or snake_case fields and preserves sessionId', () => {
    const valid = {
      venueId: 'v-123',
      eventId: 'e-456',
      sessionId: 'sess-789',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
      payload: { dishId: 'd-1' },
    };
    const parsed = validateObservationEnvelope(valid);
    expect(parsed.venueId).toBe('v-123');
    expect(parsed.eventId).toBe('e-456');
    expect(parsed.sessionId).toBe('sess-789');
    expect(parsed.type).toBe('dish_open');

    const snake = {
      venue_id: 'v-123',
      event_id: 'e-456',
      session_id: 'sess-snake',
      occurred_at: '2026-10-24T12:00:00Z',
      event_type: 'dish_open',
    };
    const parsedSnake = validateObservationEnvelope(snake);
    expect(parsedSnake.venueId).toBe('v-123');
    expect(parsedSnake.eventId).toBe('e-456');
    expect(parsedSnake.sessionId).toBe('sess-snake');
  });

  it('rejects malformed envelopes with missing required transport fields', () => {
    expect(() => validateObservationEnvelope(null)).toThrow('Message body must be an object');
    expect(() => validateObservationEnvelope({})).toThrow('Missing or invalid venueId');
    expect(() => validateObservationEnvelope({ venueId: 'v1' })).toThrow(
      'Missing or invalid eventId',
    );
    expect(() =>
      validateObservationEnvelope({ venueId: 'v1', eventId: 'e1', occurredAt: 'invalid-date' }),
    ).toThrow('Missing or invalid occurredAt timestamp');
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
      venueId: 'venue-1',
      eventId: 'evt-100',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { dishId: 'dish-1', section: 'starters' },
    };

    const disposition = await consumer.processMessage(msg);
    expect(disposition.status).toBe('acknowledged');
    if (disposition.status === 'acknowledged') {
      expect(disposition.reason).toBe('persisted');
    }

    // Verify R2 archival occurred first with expected key
    const expectedKey = 'raw/observations/venue-1/2026/10/24/evt-100.json';
    expect(r2Storage.has(expectedKey)).toBe(true);
    expect(r2Storage.putCalls.length).toBe(1);
    expect(r2Storage.putCalls[0]!.key).toBe(expectedKey);

    // Verify database canonical record exists
    const dbRecord = await repository.lookupExisting('venue-1', 'evt-100');
    expect(dbRecord).not.toBeNull();
    expect(dbRecord?.disposition).toBe('accepted');
  });

  it('Case B: Same event ID and same content acknowledged as duplicate without duplicate row or error', async () => {
    const msg = {
      venueId: 'venue-1',
      eventId: 'evt-101',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
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
    expect(repository.conflicts.length).toBe(0);
  });

  it('Case C: Same event ID with different content is quarantined in conflict table and acknowledged', async () => {
    const originalMsg = {
      venueId: 'venue-1',
      eventId: 'evt-102',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { dishId: 'dish-1', details: 'original' },
    };

    const conflictingMsg = {
      venueId: 'venue-1',
      eventId: 'evt-102',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
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
    const stored = await repository.lookupExisting('venue-1', 'evt-102');
    expect(stored).not.toBeNull();

    // Conflict table has the quarantined discrepancy
    expect(repository.conflicts.length).toBe(1);
    expect(repository.conflicts[0]!.eventId).toBe('evt-102');
    expect(repository.conflicts[0]!.venueId).toBe('venue-1');
  });

  it('Case D: Transient R2 failure returns retry and does not write to database', async () => {
    const msg = {
      venueId: 'venue-1',
      eventId: 'evt-103',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { dishId: 'dish-1' },
    };

    r2Storage.failNextPut = true;

    const disposition = await consumer.processMessage(msg);
    expect(disposition.status).toBe('retry');

    // Database must not have been reached
    const dbRecord = await repository.lookupExisting('venue-1', 'evt-103');
    expect(dbRecord).toBeNull();
  });

  it('Case D2: Transient database failure after R2 archival returns retry and allows safe replay', async () => {
    const msg = {
      venueId: 'venue-1',
      eventId: 'evt-104',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { dishId: 'dish-1' },
    };

    // DB fails on first try
    repository.failNextPersist = true;

    const d1 = await consumer.processMessage(msg);
    expect(d1.status).toBe('retry');

    // R2 archive already created
    const expectedKey = 'raw/observations/venue-1/2026/10/24/evt-104.json';
    expect(r2Storage.has(expectedKey)).toBe(true);

    // DB was not persisted
    expect(await repository.lookupExisting('venue-1', 'evt-104')).toBeNull();

    // On retry, R2 sees existing key without error, and DB write succeeds
    const d2 = await consumer.processMessage(msg);
    expect(d2.status).toBe('acknowledged');
    expect(await repository.lookupExisting('venue-1', 'evt-104')).not.toBeNull();
  });

  it('Case E: Malformed message returns dead_letter disposition', async () => {
    const malformed = {
      venueId: 'venue-1',
      // Missing eventId
      type: 'dish_open',
    };

    const disposition = await consumer.processMessage(malformed);
    expect(disposition.status).toBe('dead_letter');
  });

  it('Case F: Partial batch failure handles messages independently', async () => {
    const validMsg1 = new FakeQueueMessage('msg-1', {
      venueId: 'v1',
      eventId: 'e1',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { step: 1 },
    });

    const malformedMsg = new FakeQueueMessage('msg-2', {
      venueId: 'v1',
      // missing eventId
      type: 'dish_open',
    });

    const transientFailMsg = new FakeQueueMessage('msg-3', {
      venueId: 'v1',
      eventId: 'e3',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { step: 3 },
    });

    const validMsg4 = new FakeQueueMessage('msg-4', {
      venueId: 'v1',
      eventId: 'e4',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { step: 4 },
    });

    const batch = new FakeMessageBatch('observations-queue', [
      validMsg1,
      malformedMsg,
      transientFailMsg,
      validMsg4,
    ]);

    // Make msg-3 fail on DB (specifically targeting e3)
    repository.failOnEventId = 'e3';

    const result = await consumer.processBatch(batch);

    expect(result.processed).toBe(4);
    expect(result.acknowledged).toBe(3); // msg-1, malformedMsg (dead-lettered & acked), msg-4
    expect(result.retried).toBe(1); // msg-3
    expect(result.deadLettered).toBe(1); // msg-2

    expect(validMsg1.acked).toBe(true);
    expect(validMsg1.retried).toBe(false);

    expect(malformedMsg.acked).toBe(true); // Terminally handled
    expect(malformedMsg.retried).toBe(false);

    expect(transientFailMsg.acked).toBe(false);
    expect(transientFailMsg.retried).toBe(true);

    expect(validMsg4.acked).toBe(true);
    expect(validMsg4.retried).toBe(false);
  });

  it('Operation ordering: explicitly asserts R2 archival precedes database persistence precedes message ack', async () => {
    const traceLog: string[] = [];
    const tracingConsumer = new QueueConsumer({
      r2Storage,
      repository,
      onTrace: (op) => traceLog.push(op),
    });

    const msg = new FakeQueueMessage('msg-order', {
      venueId: 'v-ord',
      eventId: 'e-ord',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
      payload: { dishId: 'd-ord' },
    });
    const batch = new FakeMessageBatch('q-order', [msg]);

    await tracingConsumer.processBatch(batch);

    expect(traceLog).toEqual(['r2.put', 'db.persistCanonical', 'msg.ack']);
    expect(msg.acked).toBe(true);
  });

  it('R2 mismatching checksum on existing key is quarantined as conflict and prevents canonical DB row', async () => {
    // Seed R2 with existing archive for this event with a different checksum
    const existingKey = 'raw/observations/v-conflict/2026/10/24/e-conflict.json';
    r2Storage.setExisting(
      existingKey,
      new TextEncoder().encode(JSON.stringify({ step: 'original-payload' })),
      'orig-checksum-1111',
    );

    const conflictingIncomingMsg = {
      venueId: 'v-conflict',
      eventId: 'e-conflict',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { step: 'tampered-payload' },
    };

    const disposition = await consumer.processMessage(conflictingIncomingMsg);
    expect(disposition.status).toBe('acknowledged');
    if (disposition.status === 'acknowledged') {
      expect(disposition.reason).toBe('conflict_recorded');
    }

    // Must NOT have created a canonical row in observation_index
    const dbRecord = await repository.lookupExisting('v-conflict', 'e-conflict');
    expect(dbRecord).toBeNull();

    // Must have recorded in observation_conflict
    expect(repository.conflicts.length).toBe(1);
    expect(repository.conflicts[0]!.originalChecksum).toBe('orig-checksum-1111');
  });

  it('Conflict record persistence failure returns retry disposition to prevent data loss', async () => {
    const originalMsg = {
      venueId: 'v-retry',
      eventId: 'e-retry',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { val: 1 },
    };

    // First, persist canonical row
    await consumer.processMessage(originalMsg);

    // Second, conflicting message arrives
    const conflictingMsg = {
      venueId: 'v-retry',
      eventId: 'e-retry',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: { val: 999 },
    };

    // Cause conflict table insert to fail
    repository.failNextRecordConflict = true;

    const disposition = await consumer.processMessage(conflictingMsg);
    expect(disposition.status).toBe('retry');
    if (disposition.status === 'retry') {
      expect(disposition.error.message).toContain('Conflict table insertion failed');
    }

    // On subsequent retry when failure is cleared, conflict recording succeeds and message is acknowledged
    const d2 = await consumer.processMessage(conflictingMsg);
    expect(d2.status).toBe('acknowledged');
    if (d2.status === 'acknowledged') {
      expect(d2.reason).toBe('conflict_recorded');
    }
  });

  it('Raw payload preservation: preserves raw incoming string bytes in R2', async () => {
    const rawJsonString =
      '{\n  "venue_id": "v-raw",\n  "event_id": "e-raw",\n  "occurred_at": "2026-10-24T10:00:00Z",\n  "type": "dish_open",\n  "payload": { "x": 1 }\n}';
    const parsedObj = JSON.parse(rawJsonString);

    await consumer.processMessage(parsedObj);

    const key = 'raw/observations/v-raw/2026/10/24/e-raw.json';
    const stored = await r2Storage.getRawPayload(key);
    expect(stored).not.toBeNull();
    const storedText = new TextDecoder().decode(stored!.rawBytes);
    expect(JSON.parse(storedText)).toEqual(parsedObj);
  });

  it('Archive key security: rejects path traversal attempts in venueId and eventId', async () => {
    const maliciousVenue = {
      venueId: '../../etc/passwd',
      eventId: 'e-ok',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: {},
    };

    const dispVenue = await consumer.processMessage(maliciousVenue);
    expect(dispVenue.status).toBe('dead_letter');

    const maliciousEvent = {
      venueId: 'v-ok',
      eventId: '../sub/path',
      schemaVersion: 2,
      occurredAt: '2026-10-24T10:00:00Z',
      type: 'dish_open',
      payload: {},
    };

    const dispEvent = await consumer.processMessage(maliciousEvent);
    expect(dispEvent.status).toBe('dead_letter');
  });

  it('Concurrent processing of identical payloads resolves deterministically to exactly one canonical row', async () => {
    const msg = {
      venueId: 'v-concurrent',
      eventId: 'e-concurrent',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
      payload: { concurrent: true },
    };

    // Simulate concurrent dispatch of identical message
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
    expect(repository.conflicts.length).toBe(0);
  });

  it('Concurrent processing of conflicting payloads creates one canonical row and one quarantined conflict', async () => {
    const msgA = {
      venueId: 'v-race-conflict',
      eventId: 'e-race-conflict',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
      payload: { branch: 'A' },
    };

    const msgB = {
      venueId: 'v-race-conflict',
      eventId: 'e-race-conflict',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
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

    // Exactly one canonical row preserved
    expect(repository.index.size).toBe(1);
    // Exactly one conflict quarantined
    expect(repository.conflicts.length).toBe(1);
  });

  it('Repeated 5x identical deliveries: exactly 1 canonical record, 0 conflicts, all acknowledged safely', async () => {
    const msg = {
      venueId: 'v-5x',
      eventId: 'e-5x',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
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
    expect(repository.conflicts.length).toBe(0);
  });

  it('Repeated conflicting deliveries: original canonical row remains intact, all conflicts recorded', async () => {
    const canonicalMsg = {
      venueId: 'v-repeat-conflict',
      eventId: 'e-repeat-conflict',
      schemaVersion: 2,
      occurredAt: '2026-10-24T12:00:00Z',
      type: 'dish_open',
      payload: { canonical: true },
    };

    await consumer.processMessage(canonicalMsg);

    for (let i = 1; i <= 3; i++) {
      const conflictingMsg = {
        venueId: 'v-repeat-conflict',
        eventId: 'e-repeat-conflict',
        schemaVersion: 2,
        occurredAt: '2026-10-24T12:00:00Z',
        type: 'dish_open',
        payload: { mutation: i },
      };
      const disposition = await consumer.processMessage(conflictingMsg);
      expect(disposition.status).toBe('acknowledged');
      expect((disposition as { reason: string }).reason).toBe('conflict_recorded');
    }

    // Original row preserved unchanged
    const canonical = await repository.lookupExisting('v-repeat-conflict', 'e-repeat-conflict');
    expect(canonical).not.toBeNull();
    expect(repository.index.size).toBe(1);
    // All 3 conflicts captured
    expect(repository.conflicts.length).toBe(3);
  });
});

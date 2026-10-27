import { canonicalJson, sha256, toCanonicalObservation } from '@peekaplate/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeObservationRepository } from './database';
import {
  MalformedMessageError,
  type MessageBatch,
  QueueConsumer,
  type QueueMessage,
  validateConflictObservationEnvelope,
  validateObservationEnvelope,
  validateQueueEnvelope,
} from './queue-consumer';
import { FakeR2ArchiveStorage } from './r2-storage';
import { buildConflictArchiveKey, buildRawArchiveKey } from './types';

class FakeQueueMessage<T = unknown> implements QueueMessage<T> {
  public acked = false;
  public retried = false;
  public retryDelay?: number | undefined;
  public attempts = 1;
  public timestamp = new Date();

  constructor(
    public readonly id: string,
    public readonly body: T,
  ) {}

  ack(): void {
    this.acked = true;
  }

  retry(options?: { delaySeconds?: number }): void {
    this.retried = true;
    if (options?.delaySeconds !== undefined) {
      this.retryDelay = options.delaySeconds;
    }
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
const S1 = '44444444-4444-4444-8444-444444444444';
const PROD1 = '55555555-5555-4555-8555-555555555555';
const DISH1 = '66666666-6666-4666-8666-666666666666';
const DISH_REV1 = '77777777-7777-4777-8777-777777777777';
const EXP1 = '88888888-8888-4888-8888-888888888888';
const OPEN1 = '99999999-9999-4999-8999-999999999999';

function createValidObservationMsg(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'observation.v2' as const,
    tenantId: T1,
    eventId: E1,
    sessionId: S1,
    schemaVersion: 'observation.v2' as const,
    occurredAt: '2026-10-24T10:00:00.000Z',
    type: 'dish_viewed' as const,
    authorizedPublicationId: P1,
    producerId: PROD1,
    localSequence: 1,
    payload: {
      dish_id: DISH1,
      dish_revision_id: DISH_REV1,
      exposure_id: EXP1,
      surface: 'menu_list' as const,
      position: 1,
      exposure_basis: 'viewport_50pct_1s' as const,
    },
    firstReceivedAt: '2026-10-24T10:00:01.000Z',
    ...overrides,
  };
}

function createValidConflictMsg(overrides: Record<string, unknown> = {}) {
  const checksumA = 'a'.repeat(64);
  const checksumB = 'b'.repeat(64);
  return {
    kind: 'observation_conflict.v1' as const,
    tenantId: T1,
    eventId: E1,
    authorizedPublicationId: P1,
    firstReceivedAt: '2026-10-24T12:00:01.000Z',
    reasonCode: 'event_id_conflict' as const,
    copies: [
      {
        validation: 'valid' as const,
        canonicalChecksum: checksumA,
        event: {
          schema_version: 'observation.v2' as const,
          event_id: E1,
          session_id: S1,
          producer_id: PROD1,
          local_sequence: 1,
          occurred_at: '2026-10-24T12:00:00.000Z',
          publication_revision_id: P1,
          type: 'shortlist_viewed' as const,
          payload: { shortlist_size: 1 },
        },
      },
      {
        validation: 'invalid' as const,
        canonicalChecksum: checksumB,
        metadata: {
          schemaVersionStatus: 'observation.v2' as const,
          eventType: 'shortlist_viewed' as const,
          occurredAt: '2026-10-24T12:00:00.000Z',
          publicationStatus: 'matches_authority' as const,
          payloadObject: true,
        },
      },
    ],
    ...overrides,
  };
}

describe('validateObservationEnvelope', () => {
  it('validates a correct envelope with string observation.v2, UUIDs, and preserves sessionId', () => {
    const valid = createValidObservationMsg();
    const parsed = validateObservationEnvelope(valid);
    expect(parsed.tenantId).toBe(T1);
    expect(parsed.eventId).toBe(E1);
    expect(parsed.authorizedPublicationId).toBe(P1);
    expect(parsed.sessionId).toBe(S1);
    expect(parsed.schemaVersion).toBe('observation.v2');
    expect(parsed.type).toBe('dish_viewed');
    expect(parsed.localSequence).toBe(1);
    expect(parsed.producerId).toBe(PROD1);
  });

  it('rejects browser-facing snake_case formats at the queue envelope boundary', () => {
    const snake = {
      kind: 'observation.v2',
      tenant_id: T1,
      event_id: E1,
      authorized_publication_id: P1,
      session_id: S1,
      schema_version: 'observation.v2',
      occurred_at: '2026-10-24T12:00:00.000Z',
      event_type: 'menu_viewed',
    };
    expect(() => validateObservationEnvelope(snake)).toThrow(/Missing or invalid tenantId/);
  });

  it('rejects malformed envelopes with missing or non-UUID fields', () => {
    expect(() => validateObservationEnvelope(null)).toThrow('Message body must be an object');
    expect(() => validateObservationEnvelope({})).toThrow(
      /Unsupported envelope kind|Missing or invalid tenantId/,
    );
    expect(() =>
      validateObservationEnvelope({ kind: 'observation.v2', tenantId: 'not-a-uuid' }),
    ).toThrow('Missing or invalid tenantId');
    expect(() => validateObservationEnvelope({ kind: 'observation.v2', tenantId: T1 })).toThrow(
      'Missing or invalid eventId',
    );
    expect(() =>
      validateObservationEnvelope(
        createValidObservationMsg({ authorizedPublicationId: 'not-a-uuid' }),
      ),
    ).toThrow('Missing or invalid authorizedPublicationId');
    expect(() =>
      validateObservationEnvelope(createValidObservationMsg({ sessionId: 'not-a-uuid' })),
    ).toThrow();
  });

  it('rejects legacy numeric schema version or unknown string schema version', () => {
    expect(() =>
      validateObservationEnvelope(createValidObservationMsg({ schemaVersion: 2 })),
    ).toThrow(/Unsupported schemaVersion: expected 'observation.v2'/);

    expect(() =>
      validateObservationEnvelope(createValidObservationMsg({ schemaVersion: 'observation.v1' })),
    ).toThrow(/Unsupported schemaVersion: expected 'observation.v2'/);
  });

  it('rejects unsupported event types', () => {
    expect(() =>
      validateObservationEnvelope(createValidObservationMsg({ type: 'non_existent_event_type' })),
    ).toThrow(/Unsupported observation type: non_existent_event_type/);
  });

  it('rejects invalid payload violating event-specific contract', () => {
    expect(() =>
      validateObservationEnvelope(
        createValidObservationMsg({
          type: 'menu_viewed',
          payload: { entry_source: 'invalid_source' },
        }),
      ),
    ).toThrow(/Invalid observation payload/);
  });
});

describe('validateConflictObservationEnvelope and validateQueueEnvelope', () => {
  it('validates a valid observation_conflict.v1 envelope with copies', () => {
    const raw = createValidConflictMsg();
    const parsed = validateQueueEnvelope(raw);
    expect(parsed.kind).toBe('observation_conflict.v1');
    if (parsed.kind !== 'observation_conflict.v1') {
      throw new Error('Expected conflict envelope');
    }
    expect(parsed.tenantId).toBe(T1);
    expect(parsed.eventId).toBe(E1);
    expect(parsed.authorizedPublicationId).toBe(P1);
    expect(parsed.reasonCode).toBe('event_id_conflict');
    expect(parsed.copies).toHaveLength(2);
  });

  it('rejects malformed conflict envelopes with missing or non-UUID fields', () => {
    expect(() =>
      validateConflictObservationEnvelope({
        kind: 'observation_conflict.v1',
        tenantId: 'bad-uuid',
        eventId: E1,
        authorizedPublicationId: P1,
        reasonCode: 'event_id_conflict',
        copies: [],
      }),
    ).toThrow(/Missing or invalid tenantId: must be a valid UUID/);

    expect(() =>
      validateConflictObservationEnvelope({
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: 'bad-uuid',
        authorizedPublicationId: P1,
        reasonCode: 'event_id_conflict',
        copies: [],
      }),
    ).toThrow(/Missing or invalid eventId: must be a valid UUID/);

    expect(() =>
      validateConflictObservationEnvelope({
        kind: 'observation_conflict.v1',
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: 'bad-uuid',
        reasonCode: 'event_id_conflict',
        copies: [],
      }),
    ).toThrow(/Missing or invalid authorizedPublicationId: must be a valid UUID/);
  });

  it('correctly discriminates normal observation.v2 vs conflict observation_conflict.v1 envelopes', () => {
    const normal = createValidObservationMsg();
    const conflict = createValidConflictMsg();

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
    const msg = createValidObservationMsg();

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
    const msg = createValidObservationMsg();

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
    const originalMsg = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 1,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

    const conflictingMsg = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 2, // different position -> different payload & checksum!
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

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

  describe('Top-level canonical checksum conflict detection (Phase 2 & Review Item 1)', () => {
    it('detects conflict when payload is identical but occurredAt differs', async () => {
      const msg1 = createValidObservationMsg({ occurredAt: '2026-10-24T10:00:00.000Z' });
      const msg2 = createValidObservationMsg({ occurredAt: '2026-10-24T10:05:00.000Z' });

      // First delivery persists canonical observation
      const d1 = await consumer.processMessage(msg1);
      expect(d1.status).toBe('acknowledged');
      if (d1.status === 'acknowledged') {
        expect(d1.reason).toBe('persisted');
      }

      // Second delivery shares payload but differs in occurredAt -> quarantined as conflict!
      const d2 = await consumer.processMessage(msg2);
      expect(d2.status).toBe('acknowledged');
      if (d2.status === 'acknowledged') {
        expect(d2.reason).toBe('conflict_recorded');
      }

      expect(repository.index.size).toBe(1);
      expect(repository.conflicts.size).toBe(1);
      const conflict = Array.from(repository.conflicts.values())[0]!;
      expect(conflict.eventId).toBe(E1);
      expect(r2Storage.has(conflict.r2ArchiveKey)).toBe(true);
    });

    it('detects conflict when payload is identical but sessionId differs', async () => {
      const s2 = '44444444-4444-4444-8444-444444444499';
      const msg1 = createValidObservationMsg({ sessionId: S1 });
      const msg2 = createValidObservationMsg({ sessionId: s2 });

      await consumer.processMessage(msg1);
      const d2 = await consumer.processMessage(msg2);
      expect(d2.status).toBe('acknowledged');
      if (d2.status === 'acknowledged') {
        expect(d2.reason).toBe('conflict_recorded');
      }
      expect(repository.conflicts.size).toBe(1);
    });

    it('detects conflict when payload is identical but authorizedPublicationId differs', async () => {
      const p2 = '33333333-3333-4333-8333-333333333399';
      const msg1 = createValidObservationMsg({ authorizedPublicationId: P1 });
      const msg2 = createValidObservationMsg({ authorizedPublicationId: p2 });

      await consumer.processMessage(msg1);
      const d2 = await consumer.processMessage(msg2);
      expect(d2.status).toBe('acknowledged');
      if (d2.status === 'acknowledged') {
        expect(d2.reason).toBe('conflict_recorded');
      }
      expect(repository.conflicts.size).toBe(1);
    });

    it('detects conflict when payload is identical but producerId or localSequence differs', async () => {
      const prod2 = '55555555-5555-4555-8555-555555555599';
      const msg1 = createValidObservationMsg({ producerId: PROD1, localSequence: 1 });
      const msg2 = createValidObservationMsg({ producerId: prod2, localSequence: 2 });

      await consumer.processMessage(msg1);
      const d2 = await consumer.processMessage(msg2);
      expect(d2.status).toBe('acknowledged');
      if (d2.status === 'acknowledged') {
        expect(d2.reason).toBe('conflict_recorded');
      }
      expect(repository.conflicts.size).toBe(1);
    });

    it('detects conflict when eventId is identical but type differs', async () => {
      const msg1 = createValidObservationMsg({
        type: 'dish_detail_closed',
        payload: {
          dish_id: DISH1,
          dish_revision_id: DISH_REV1,
          opening_id: '88888888-8888-4888-8888-888888888888',
        },
      });
      const msg2 = createValidObservationMsg({
        type: 'dish_activity_checkpoint',
        payload: {
          dish_id: DISH1,
          dish_revision_id: DISH_REV1,
          opening_id: '88888888-8888-4888-8888-888888888888',
          active_ms: 10000,
          final: true,
        },
      });

      // First delivery persists canonical observation
      const d1 = await consumer.processMessage(msg1);
      expect(d1.status).toBe('acknowledged');
      if (d1.status === 'acknowledged') {
        expect(d1.reason).toBe('persisted');
      }

      // Second delivery shares eventId but differs in type -> quarantined as conflict!
      const d2 = await consumer.processMessage(msg2);
      expect(d2.status).toBe('acknowledged');
      if (d2.status === 'acknowledged') {
        expect(d2.reason).toBe('conflict_recorded');
      }

      expect(repository.index.size).toBe(1);
      const original = repository.index.get(`${T1}:${E1}`);
      expect(original?.eventType).toBe('dish_detail_closed');
      expect(repository.conflicts.size).toBe(1);
      const conflict = Array.from(repository.conflicts.values())[0]!;
      expect(conflict.eventId).toBe(E1);
      expect(r2Storage.has(conflict.r2ArchiveKey)).toBe(true);
    });

    it('rejects message as malformed when type is changed but payload is invalid for that type', async () => {
      // dish_viewed payload with type menu_viewed violates ObservationQueueMessageSchema superRefine
      const msg = createValidObservationMsg({
        type: 'menu_viewed',
        payload: {
          dish_id: DISH1,
          dish_revision_id: DISH_REV1,
          exposure_id: EXP1,
          surface: 'menu_list',
          position: 1,
          exposure_basis: 'viewport_50pct_1s',
        },
      });

      const disposition = await consumer.processMessage(msg);
      expect(disposition.status).toBe('dead_letter');
      expect(repository.index.size).toBe(0);
      expect(repository.conflicts.size).toBe(0);
    });

    it('verifies producer and consumer generate matching canonical checksums for the same observation', async () => {
      const msg = createValidObservationMsg();
      const canonicalObs = toCanonicalObservation(msg);
      const canonicalStr = canonicalJson(canonicalObs);
      const consumerChecksum = await sha256(canonicalStr);

      // Emulate producer's exact canonical observation and checksum
      const producerObs = {
        schema_version: 'observation.v2' as const,
        event_id: msg.eventId,
        session_id: msg.sessionId,
        producer_id: msg.producerId,
        local_sequence: msg.localSequence,
        occurred_at: msg.occurredAt,
        publication_revision_id: msg.authorizedPublicationId,
        type: msg.type,
        payload: msg.payload,
      };
      const producerCanonicalStr = canonicalJson(producerObs);
      const producerChecksum = await sha256(producerCanonicalStr);

      expect(consumerChecksum).toBe(producerChecksum);

      // Persist via consumer and verify stored checksum
      await consumer.processMessage(msg);
      const stored = repository.index.get(`${T1}:${E1}`);
      expect(stored?.checksum).toBe(producerChecksum);
    });
  });

  it('Case D: Transient R2 failure returns retry and does not write to database', async () => {
    const msg = createValidObservationMsg();
    r2Storage.failNextPut = true;

    const disposition = await consumer.processMessage(msg);
    expect(disposition.status).toBe('retry');

    // Database must not have been reached
    const dbRecord = await repository.lookupExisting(T1, E1);
    expect(dbRecord).toBeNull();
  });

  it('Case D2: Transient database failure after R2 archival returns retry and allows safe replay', async () => {
    const msg = createValidObservationMsg();

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

  describe('Malformed envelope regressions and safe DLQ handling (Findings B & C / Section 5 & 8.B)', () => {
    it('Case E: Malformed message returns dead_letter disposition and does not write to R2 or DB', async () => {
      const malformed = {
        tenantId: T1,
        // Missing eventId, kind, etc.
        type: 'dish_viewed',
      };

      const disposition = await consumer.processMessage(malformed);
      expect(disposition.status).toBe('dead_letter');
      expect(repository.index.size).toBe(0);
      expect(repository.conflicts.size).toBe(0);
      expect(r2Storage.putCalls.length).toBe(0);
    });

    it('rejects envelope missing required top-level fields', async () => {
      const fields = [
        'kind',
        'tenantId',
        'eventId',
        'sessionId',
        'schemaVersion',
        'occurredAt',
        'type',
        'authorizedPublicationId',
        'producerId',
        'localSequence',
        'payload',
        'firstReceivedAt',
      ] as const;

      for (const field of fields) {
        const msg = createValidObservationMsg();
        delete (msg as Record<string, unknown>)[field];
        const disposition = await consumer.processMessage(msg);
        expect(disposition.status).toBe('dead_letter');
      }
      expect(repository.index.size).toBe(0);
      expect(r2Storage.putCalls.length).toBe(0);
    });

    it('rejects envelope with invalid types for required fields', async () => {
      // localSequence must be positive safe integer
      const nonIntSeq = createValidObservationMsg({ localSequence: '1' as unknown as number });
      expect((await consumer.processMessage(nonIntSeq)).status).toBe('dead_letter');

      const zeroSeq = createValidObservationMsg({ localSequence: 0 });
      expect((await consumer.processMessage(zeroSeq)).status).toBe('dead_letter');

      const negSeq = createValidObservationMsg({ localSequence: -5 });
      expect((await consumer.processMessage(negSeq)).status).toBe('dead_letter');

      // schemaVersion must be string literal 'observation.v2'
      const numSchemaVer = createValidObservationMsg({
        schemaVersion: 2 as unknown as 'observation.v2',
      });
      expect((await consumer.processMessage(numSchemaVer)).status).toBe('dead_letter');
    });

    it('rejects envelope with invalid timestamps or identifiers', async () => {
      const badTimestamp = createValidObservationMsg({ occurredAt: '2026-13-45T99:99:99.999Z' });
      expect((await consumer.processMessage(badTimestamp)).status).toBe('dead_letter');

      const badEventId = createValidObservationMsg({ eventId: 'not-a-valid-uuid' });
      expect((await consumer.processMessage(badEventId)).status).toBe('dead_letter');

      const badTenantId = createValidObservationMsg({ tenantId: 'not-a-valid-uuid' });
      expect((await consumer.processMessage(badTenantId)).status).toBe('dead_letter');
    });

    it('rejects envelope with missing or malformed nested payloads', async () => {
      const nullPayload = createValidObservationMsg({
        payload: null as unknown as Record<string, unknown>,
      });
      expect((await consumer.processMessage(nullPayload)).status).toBe('dead_letter');

      // dish_viewed requires dish_id, dish_revision_id, exposure_id, surface, position, exposure_basis
      const emptyPayload = createValidObservationMsg({ payload: {} });
      expect((await consumer.processMessage(emptyPayload)).status).toBe('dead_letter');

      const missingProp = createValidObservationMsg({
        payload: {
          dish_id: DISH1,
          dish_revision_id: DISH_REV1,
          // missing exposure_id, surface, position, exposure_basis
        },
      });
      expect((await consumer.processMessage(missingProp)).status).toBe('dead_letter');
    });

    it('rejects unsupported event types or schema versions', async () => {
      const badType = createValidObservationMsg({ type: 'unknown_event' as unknown as any });
      expect((await consumer.processMessage(badType)).status).toBe('dead_letter');

      const badSchemaVer = createValidObservationMsg({
        schemaVersion: 'observation.v3' as unknown as any,
      });
      expect((await consumer.processMessage(badSchemaVer)).status).toBe('dead_letter');
    });

    it('rejects legacy permissive envelope formats from PR #31 initial implementation', async () => {
      // Legacy PR #31 accepted permissive shape with numeric schemaVersion, venueId instead of tenantId, arbitrary type
      const legacyPermissive = {
        venueId: T1,
        eventId: E1,
        sessionId: S1,
        schemaVersion: 2,
        occurredAt: '2026-10-24T12:00:00.000Z',
        type: 'custom_unregistered_event',
        payload: { arbitrary: 'data' },
      };
      const disposition = await consumer.processMessage(legacyPermissive);
      expect(disposition.status).toBe('dead_letter');
      expect(repository.index.size).toBe(0);
    });

    it('routes dead_letter messages to retry for Cloudflare DLQ exhaustion, never prematurely calling ack()', async () => {
      const malformedMsg = new FakeQueueMessage('msg-bad', {
        tenantId: T1,
        type: 'unsupported',
      });
      const batch = new FakeMessageBatch('peekaplate-staging-observations', [malformedMsg]);

      const result = await consumer.processBatch(batch);
      expect(result.processed).toBe(1);
      expect(result.acknowledged).toBe(0);
      expect(result.retried).toBe(1);
      expect(result.deadLettered).toBe(1);

      // Crucial: msg.ack() must NOT be called on malformed message
      expect(malformedMsg.acked).toBe(false);
      // msg.retry() must be called so Cloudflare Queues delivers to configured DLQ on max retries
      expect(malformedMsg.retried).toBe(true);
    });
  });

  it('DEF-03 regression: safely processes an observation payload with undefined optional properties without crashing batch', async () => {
    const msgWithUndefined = createValidObservationMsg({
      eventId: '22222222-2222-4222-8222-222222222299',
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list',
        position: 1,
        exposure_basis: 'viewport_50pct_1s',
        category_filter: undefined, // optional field explicitly set to undefined
      },
    });

    const disposition = await consumer.processMessage(msgWithUndefined);
    expect(disposition.status).toBe('acknowledged');
    if (disposition.status === 'acknowledged') {
      expect(disposition.reason).toBe('persisted');
    }
  });

  it('Case F: Partial batch failure handles messages independently', async () => {
    const e2 = '22222222-2222-4222-8222-222222222202';
    const e3 = '22222222-2222-4222-8222-222222222203';
    const e4 = '22222222-2222-4222-8222-222222222204';

    const validMsg1 = new FakeQueueMessage('msg-1', createValidObservationMsg({ eventId: E1 }));

    const malformedMsg = new FakeQueueMessage('msg-2', {
      tenantId: T1,
      // missing eventId
      type: 'menu_viewed',
    });

    const transientFailMsg = new FakeQueueMessage(
      'msg-3',
      createValidObservationMsg({ eventId: e3 }),
    );

    const validMsg4 = new FakeQueueMessage('msg-4', createValidObservationMsg({ eventId: e4 }));

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

    const msg = new FakeQueueMessage('msg-order', createValidObservationMsg());
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

    const conflictingIncomingMsg = createValidObservationMsg();

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
    const originalMsg = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 1,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

    await consumer.processMessage(originalMsg);

    const conflictingMsg = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 2,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

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
    const originalMsg = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 1,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

    await consumer.processMessage(originalMsg);

    const conflictingMsg = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 2,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

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
    const msg = createValidObservationMsg();

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
    const msgA = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 1,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

    const msgB = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 2,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

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
    const msg = createValidObservationMsg();

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
    const canonicalMsg = createValidObservationMsg({
      payload: {
        dish_id: DISH1,
        dish_revision_id: DISH_REV1,
        exposure_id: EXP1,
        surface: 'menu_list' as const,
        position: 1,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
    });

    await consumer.processMessage(canonicalMsg);

    for (let i = 2; i <= 4; i++) {
      const conflictingMsg = createValidObservationMsg({
        payload: {
          dish_id: DISH1,
          dish_revision_id: DISH_REV1,
          exposure_id: EXP1,
          surface: 'menu_list' as const,
          position: i,
          exposure_basis: 'viewport_50pct_1s' as const,
        },
      });
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
      const conflictMsg = createValidConflictMsg();

      const disposition = await consumer.processMessage(conflictMsg);
      expect(disposition.status).toBe('acknowledged');
      expect((disposition as { reason: string }).reason).toBe('conflict_recorded');

      // Canonical index must remain untouched
      expect(repository.index.size).toBe(0);
      // Both conflict copies must be recorded
      expect(repository.conflicts.size).toBe(2);
    });

    it('handles idempotent redelivery of observation_conflict.v1 safely', async () => {
      const conflictMsg = createValidConflictMsg();

      // First delivery
      const d1 = await consumer.processMessage(conflictMsg);
      expect(d1.status).toBe('acknowledged');
      expect((d1 as { reason: string }).reason).toBe('conflict_recorded');

      // Second delivery (identical retry)
      const d2 = await consumer.processMessage(conflictMsg);
      expect(d2.status).toBe('acknowledged');
      expect((d2 as { reason: string }).reason).toBe('duplicate_same_payload');

      expect(repository.conflicts.size).toBe(2);
    });

    it('retries on transient R2 failure during observation_conflict.v1 and does not acknowledge', async () => {
      r2Storage.failNextPut = true;
      const conflictMsg = createValidConflictMsg();

      const disposition = await consumer.processMessage(conflictMsg);
      expect(disposition.status).toBe('retry');
      expect(repository.conflicts.size).toBe(0);
    });

    it('retries on transient DB failure during observation_conflict.v1 and preserves R2 archive', async () => {
      repository.failNextRecordConflict = true;
      const conflictMsg = createValidConflictMsg();

      const disposition = await consumer.processMessage(conflictMsg);
      expect(disposition.status).toBe('retry');
      expect(repository.conflicts.size).toBe(0);

      // On retry, archival detects existing key and DB persist succeeds
      const d2 = await consumer.processMessage(conflictMsg);
      expect(d2.status).toBe('acknowledged');
      expect(repository.conflicts.size).toBe(2);
    });

    it('processes a batch with mixed observation.v2 and observation_conflict.v1 messages', async () => {
      const eNormal = '55555555-4555-4555-8555-555555555555';
      const eConflict = '66666666-4666-4666-8666-666666666666';

      const normalMsg = new FakeQueueMessage(
        'msg-norm',
        createValidObservationMsg({ eventId: eNormal }),
      );

      const conflictMsg = new FakeQueueMessage(
        'msg-conf',
        createValidConflictMsg({ eventId: eConflict }),
      );

      const batch = new FakeMessageBatch('q-mixed', [normalMsg, conflictMsg]);
      const result = await consumer.processBatch(batch);

      expect(result.processed).toBe(2);
      expect(result.acknowledged).toBe(2);
      expect(result.retried).toBe(0);
      expect(normalMsg.acked).toBe(true);
      expect(conflictMsg.acked).toBe(true);

      expect(repository.index.size).toBe(1);
      expect(repository.conflicts.size).toBe(2);
    });

    it('handles partial failure across conflict copies safely and retries without duplicate records', async () => {
      const checksumA = '1'.repeat(64);
      const checksumB = '2'.repeat(64);

      const multiCopyMsg = {
        kind: 'observation_conflict.v1' as const,
        tenantId: T1,
        eventId: E1,
        authorizedPublicationId: P1,
        firstReceivedAt: '2026-10-24T12:00:00.000Z',
        reasonCode: 'event_id_conflict' as const,
        copies: [
          {
            validation: 'valid' as const,
            canonicalChecksum: checksumA,
            event: {
              schema_version: 'observation.v2' as const,
              event_id: E1,
              session_id: S1,
              producer_id: PROD1,
              local_sequence: 1,
              occurred_at: '2026-10-24T12:00:00.000Z',
              publication_revision_id: P1,
              type: 'shortlist_viewed' as const,
              payload: { shortlist_size: 1 },
            },
          },
          {
            validation: 'invalid' as const,
            canonicalChecksum: checksumB,
            metadata: {
              schemaVersionStatus: 'observation.v2' as const,
              eventType: 'shortlist_viewed' as const,
              occurredAt: '2026-10-24T12:00:00.000Z',
              publicationStatus: 'matches_authority' as const,
              payloadObject: true,
            },
          },
        ],
      };

      // Configure R2 to fail when writing the second copy's key
      const keyB = buildConflictArchiveKey(T1, E1, '2026-10-24T12:00:00.000Z', checksumB);
      r2Storage.failKeys.add(keyB);

      const msg = new FakeQueueMessage('msg-partial-fail', multiCopyMsg);
      const batch1 = new FakeMessageBatch('obs-queue', [msg]);

      const result1 = await consumer.processBatch(batch1);
      expect(result1.acknowledged).toBe(0);
      expect(result1.retried).toBe(1);
      expect(msg.acked).toBe(false);
      expect(msg.retried).toBe(true);

      // Copy A was persisted, but Copy B failed
      expect(repository.conflicts.size).toBe(1);
      expect(repository.conflicts.has(`${T1}:${E1}:${checksumA}`)).toBe(true);

      // Now transient R2 failure clears
      r2Storage.failKeys.delete(keyB);

      // Redeliver same message on retry
      const retryMsg = new FakeQueueMessage('msg-partial-retry', multiCopyMsg);
      const batch2 = new FakeMessageBatch('obs-queue', [retryMsg]);

      const result2 = await consumer.processBatch(batch2);
      expect(result2.acknowledged).toBe(1);
      expect(retryMsg.acked).toBe(true);

      // Both copies are now recorded; Copy A was recognized as already recorded without duplicate
      expect(repository.conflicts.size).toBe(2);
      expect(repository.conflicts.has(`${T1}:${E1}:${checksumA}`)).toBe(true);
      expect(repository.conflicts.has(`${T1}:${E1}:${checksumB}`)).toBe(true);
    });
  });
});

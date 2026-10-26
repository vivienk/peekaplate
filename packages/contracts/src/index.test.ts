import { describe, expect, it } from 'vitest';
import {
  CreateDishRevisionSchema,
  DishIntentEventSchema,
  HealthResponseSchema,
  ObservationConflictV1QueueEnvelopeSchema,
  ObservationQueueEnvelopeSchema,
  ObservationV2QueueEnvelopeSchema,
} from './index';

const event = {
  eventId: '0199b409-a700-7000-8000-000000000001',
  schemaVersion: 1,
  sessionId: '0199b409-a700-7000-8000-000000000002',
  sequence: 1,
  eventType: 'dish_open',
  occurredAt: '2026-10-13T12:00:00.000Z',
  publicationHash: 'a'.repeat(64),
  dishRevisionHash: 'b'.repeat(64),
  displayedTier: 'T0',
  rendererVersion: null,
  manifestHash: null,
  availabilityVersion: 0,
  experimentAssignment: null,
};

describe('dish observation boundary', () => {
  it('accepts a pinned photo exposure without a renderer', () => {
    expect(DishIntentEventSchema.parse(event)).toEqual(event);
  });
  it('rejects enhanced evidence on a photo-only exposure', () => {
    expect(
      DishIntentEventSchema.safeParse({ ...event, manifestHash: 'c'.repeat(64) }).success,
    ).toBe(false);
    expect(DishIntentEventSchema.safeParse({ ...event, rendererVersion: '0.183.0' }).success).toBe(
      false,
    );
  });
  it('rejects browser-supplied authority and server timestamps', () => {
    expect(DishIntentEventSchema.safeParse({ ...event, tenantId: 'spoofed' }).success).toBe(false);
    expect(
      DishIntentEventSchema.safeParse({ ...event, receivedAt: event.occurredAt }).success,
    ).toBe(false);
  });
  it('requires actual renderer and manifest versions for enhanced tiers', () => {
    expect(DishIntentEventSchema.safeParse({ ...event, displayedTier: 'T1' }).success).toBe(false);
    expect(
      DishIntentEventSchema.safeParse({
        ...event,
        displayedTier: 'T1',
        rendererVersion: '0.183.2',
        manifestHash: 'c'.repeat(64),
      }).success,
    ).toBe(true);
  });
  it('rejects malformed identity, sequence and exposure references', () => {
    for (const patch of [
      { eventId: 'invalid' },
      { sequence: 0 },
      { publicationHash: '' },
      { occurredAt: 'yesterday' },
    ]) {
      expect(DishIntentEventSchema.safeParse({ ...event, ...patch }).success).toBe(false);
    }
  });
});

it('health describes the scaffold without claiming database readiness', () => {
  expect(
    HealthResponseSchema.parse({ status: 'ok', service: 'peekaplate-api', stage: 'foundation' })
      .stage,
  ).toBe('foundation');
});

describe('dish command boundary', () => {
  const command = {
    commandId: '00000000-0000-4000-8000-000000000001',
    expectedVersion: 0,
    name: ' Soup ',
    description: ' Seasonal vegetables ',
  };
  it('normalizes content for stable retries', () => {
    expect(CreateDishRevisionSchema.parse(command)).toEqual({
      ...command,
      name: 'Soup',
      description: 'Seasonal vegetables',
    });
  });
  it('rejects claimed authority, invalid versions and oversized content', () => {
    for (const patch of [
      { actorId: command.commandId },
      { tenantId: command.commandId },
      { role: 'owner' },
      { expectedVersion: -1 },
      { expectedVersion: 0.5 },
      { expectedVersion: 2_147_483_647 },
      { name: ' ' },
      { name: 'x'.repeat(161) },
      { name: 'Soup\u0000' },
      { description: 'Text\u0000' },
      { description: 'x'.repeat(4001) },
      { commandId: 'not-a-uuid' },
    ])
      expect(CreateDishRevisionSchema.safeParse({ ...command, ...patch }).success).toBe(false);
  });
});

describe('ObservationQueueEnvelopeSchema contract boundary', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const eventId = '22222222-2222-4222-8222-222222222222';
  const pubId = '33333333-3333-4333-8333-333333333333';

  const validNormal = {
    kind: 'observation.v2' as const,
    tenantId,
    eventId,
    authorizedPublicationId: pubId,
    sessionId: 'sess-001',
    schemaVersion: 'observation.v2' as const,
    occurredAt: '2026-10-24T12:00:00.000Z',
    type: 'dish_viewed' as const,
    producerId: 'prod-001',
    localSequence: 1,
    payload: { dishId: 'dish-1' },
  };

  const validConflictPayload = {
    kind: 'observation_conflict.v1' as const,
    tenantId,
    eventId,
    authorizedPublicationId: pubId,
    occurredAt: '2026-10-24T12:00:00.000Z',
    firstReceivedAt: '2026-10-24T12:00:01.000Z',
    type: 'dish_viewed',
    incomingChecksum: 'a'.repeat(64),
    conflictReason: 'event_id_conflict',
    payload: { dishId: 'dish-conflict' },
  };

  const validConflictBounded = {
    kind: 'observation_conflict.v1' as const,
    tenantId,
    eventId,
    authorizedPublicationId: pubId,
    conflictReason: 'payload_too_large',
    incomingChecksum: 'b'.repeat(64),
    boundedMetadata: { size: 35000, reasonCode: 'payload_too_large' },
  };

  it('validates canonical normal observation.v2 envelopes', () => {
    const parsed = ObservationQueueEnvelopeSchema.parse(validNormal);
    expect(parsed.kind).toBe('observation.v2');
    expect(parsed.tenantId).toBe(tenantId);
    expect(parsed.eventId).toBe(eventId);
    expect(parsed.authorizedPublicationId).toBe(pubId);

    // Defaulting kind when schemaVersion is observation.v2
    const withoutKind = { ...validNormal };
    delete (withoutKind as any).kind;
    const parsedDefault = ObservationQueueEnvelopeSchema.parse(withoutKind);
    expect(parsedDefault.kind).toBe('observation.v2');

    // Accepts ISO datetime with explicit timezone offset (e.g., +02:00, -04:00)
    const withOffset = {
      ...validNormal,
      occurredAt: '2026-10-24T14:00:00+02:00',
      firstReceivedAt: '2026-10-24T08:00:00-04:00',
    };
    const parsedOffset = ObservationQueueEnvelopeSchema.parse(withOffset);
    expect(parsedOffset.occurredAt).toBe('2026-10-24T14:00:00+02:00');
  });

  it('validates canonical conflict observation_conflict.v1 envelopes', () => {
    const parsedPayload = ObservationQueueEnvelopeSchema.parse(validConflictPayload);
    expect(parsedPayload.kind).toBe('observation_conflict.v1');
    expect(parsedPayload.tenantId).toBe(tenantId);

    const parsedBounded = ObservationQueueEnvelopeSchema.parse(validConflictBounded);
    expect(parsedBounded.kind).toBe('observation_conflict.v1');
    expect(parsedBounded.eventId).toBe(eventId);

    // Producer multi-copy batch conflict format (S3-DATA-01)
    const parsedProducerCopies = ObservationQueueEnvelopeSchema.parse({
      kind: 'observation_conflict.v1',
      tenantId,
      eventId,
      authorizedPublicationId: pubId,
      firstReceivedAt: '2026-10-24T12:00:00.000Z',
      reasonCode: 'event_id_conflict',
      copies: [
        { validation: 'valid', canonicalChecksum: 'a'.repeat(64), event: { item: 'copy-1' } },
        {
          validation: 'invalid',
          canonicalChecksum: 'b'.repeat(64),
          metadata: { reason: 'copy-2' },
        },
      ],
    });
    expect(parsedProducerCopies.kind).toBe('observation_conflict.v1');
    expect((parsedProducerCopies as any).copies).toHaveLength(2);
  });

  it('rejects browser-facing snake_case formats at the queue boundary', () => {
    const snakeCase = {
      tenant_id: tenantId,
      event_id: eventId,
      authorized_publication_id: pubId,
      schema_version: 'observation.v2',
      occurred_at: '2026-10-24T12:00:00.000Z',
      type: 'dish_viewed',
      payload: {},
    };
    expect(ObservationQueueEnvelopeSchema.safeParse(snakeCase).success).toBe(false);
  });

  it('rejects unknown envelope kinds and unsupported schema versions', () => {
    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        kind: 'observation.v3',
      }).success,
    ).toBe(false);

    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        schemaVersion: 'observation.v1',
      }).success,
    ).toBe(false);

    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validConflictPayload,
        kind: 'unknown_conflict',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid UUIDs and unauthorized/malformed identifiers', () => {
    for (const badUuid of ['not-a-uuid', '12345', '', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) {
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          tenantId: badUuid,
        }).success,
      ).toBe(false);
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          eventId: badUuid,
        }).success,
      ).toBe(false);
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          authorizedPublicationId: badUuid,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects unknown observation types', () => {
    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        type: 'unsupported_event_type',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown extra properties on strict objects', () => {
    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        extraInjectedField: 'unauthorized',
      }).success,
    ).toBe(false);

    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validConflictPayload,
        extraInjectedField: 'unauthorized',
      }).success,
    ).toBe(false);
  });
});

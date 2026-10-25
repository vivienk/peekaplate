import { describe, expect, it, vi } from 'vitest';
import app, { createApp } from './index';
import { ingestObservations } from './observation-ingest';

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

describe('observation.v2 HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const publicationId = '00000000-0000-4000-8000-000000000002';
  const jti = '00000000-0000-4000-8000-000000000003';
  const event = () => ({
    schema_version: 'observation.v2',
    event_id: crypto.randomUUID(),
    type: 'dish_saved',
    session_id: crypto.randomUUID(),
    producer_id: crypto.randomUUID(),
    local_sequence: 1,
    occurred_at: new Date().toISOString(),
    publication_revision_id: publicationId,
    payload: {
      dish_id: crypto.randomUUID(),
      dish_revision_id: crypto.randomUUID(),
      save_origin: 'direct',
      save_surface: 'dish_detail',
      shortlist_size: 1,
    },
  });
  const request = (events: unknown[], init: RequestInit = {}) =>
    new Request('http://localhost/observations', {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: 'observation.v2', events }),
      ...init,
    });
  const baseServices = {
    verify: vi.fn(),
    execute: vi.fn(),
    verifyMenu: vi.fn().mockResolvedValue({ venueId, publicationId, jti }),
    consumeObservationRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 1 }),
  };

  it('derives authority from the token and accepts only after Queue send resolves', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const input = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([input]),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      contract: 'observation-receipt.v1',
      receipts: [
        { event_id: input.event_id, status: 'accepted', reason_code: null, retryable: false },
      ],
    });
    expect(enqueueObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: venueId,
        authorizedPublicationId: publicationId,
        schemaVersion: 'observation.v2',
        eventId: input.event_id,
      }),
      {},
    );
  });

  it('returns per-item permanent rejections without enqueueing invalid observations', async () => {
    const enqueueObservation = vi.fn();
    const valid = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([
        { ...valid, schema_version: 2 },
        { ...event(), type: 'ingredient_viewed' },
        { ...event(), publication_revision_id: crypto.randomUUID() },
        { ...event(), occurred_at: new Date(Date.now() - 86_400_001).toISOString() },
        { ...event(), occurred_at: new Date(Date.now() + 360_001).toISOString() },
      ]),
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()).receipts.map(
        (receipt: { reason_code: string }) => receipt.reason_code,
      ),
    ).toEqual([
      'schema_invalid',
      'unknown_type',
      'publication_not_allowed',
      'too_old',
      'future_time',
    ]);
    expect(enqueueObservation).not.toHaveBeenCalled();
  });

  it('enqueues identical IDs once and rejects every conflicting in-batch copy', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const first = event();
    const conflict = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([
        first,
        structuredClone(first),
        conflict,
        { ...conflict, payload: { ...conflict.payload, shortlist_size: 2 } },
      ]),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).receipts).toMatchObject([
      { status: 'accepted', reason_code: null },
      { status: 'accepted', reason_code: 'duplicate_in_batch' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
    ]);
    expect(enqueueObservation).toHaveBeenCalledTimes(2);
    expect(enqueueObservation.mock.calls.map(([message]) => message.kind)).toEqual([
      'observation_conflict.v1',
      'observation.v2',
    ]);
  });

  it('returns mixed receipts, but 503 without receipts when every Queue send is unavailable', async () => {
    const first = event();
    const second = event();
    const partial = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('queue unavailable'));
    const partialResponse = await createApp({ ...baseServices, enqueueObservation: partial }).fetch(
      request([first, second]),
    );
    expect(partialResponse.status).toBe(200);
    expect((await partialResponse.json()).receipts).toMatchObject([
      { status: 'accepted', retryable: false },
      { status: 'retry', retryable: true },
    ]);

    const unavailableResponse = await createApp({
      ...baseServices,
      enqueueObservation: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    }).fetch(request([event()]));
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({ error: 'queue_unavailable' });
  });

  it('enforces authentication, token-scoped throttling and envelope limits before Queue use', async () => {
    const enqueueObservation = vi.fn();
    const app = createApp({ ...baseServices, enqueueObservation });
    const missingAuth = await app.fetch(
      request([event()], { headers: { 'Content-Type': 'application/json' } }),
    );
    expect(missingAuth.status).toBe(401);

    const limited = await createApp({
      ...baseServices,
      consumeObservationRateLimit: vi
        .fn()
        .mockResolvedValue({ allowed: false, retryAfterSeconds: 3 }),
      enqueueObservation,
    }).fetch(request([event()]));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('3');

    const tooMany = await app.fetch(request(Array.from({ length: 26 }, event)));
    expect(tooMany.status).toBe(413);

    const malformed = await app.fetch(
      new Request('http://localhost/observations', {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(enqueueObservation).not.toHaveBeenCalled();
  });
  it('detects same-ID conflicts before per-item validation and quarantines both copies', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const valid = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([
        valid,
        {
          ...valid,
          schema_version: 2,
          search_text: 'private query',
          email: 'person@example.com',
          credential: 'secret-value',
          full_url: 'https://example.com/private?token=secret',
        },
      ]),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).receipts).toMatchObject([
      { status: 'rejected', reason_code: 'event_id_conflict' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
    ]);
    expect(enqueueObservation).toHaveBeenCalledTimes(1);
    expect(enqueueObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'observation_conflict.v1',
        tenantId: venueId,
        eventId: valid.event_id,
        authorizedPublicationId: publicationId,
        copies: expect.arrayContaining([
          expect.objectContaining({ validation: 'valid', event: valid }),
          expect.objectContaining({
            validation: 'invalid',
            metadata: expect.objectContaining({ schemaVersionStatus: 'other' }),
          }),
        ]),
      }),
      {},
    );
    const conflictMessage = enqueueObservation.mock.calls[0]?.[0];
    expect(JSON.stringify(conflictMessage)).not.toContain('private query');
    expect(JSON.stringify(conflictMessage)).not.toContain('person@example.com');
    expect(JSON.stringify(conflictMessage)).not.toContain('secret-value');
    expect(JSON.stringify(conflictMessage)).not.toContain('example.com/private');
  });

  it('rejects deeply nested invalid JSON without recursive canonicalization failure', async () => {
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 12_000; depth += 1) payload = [payload];
    const enqueue = vi.fn();
    const result = await ingestObservations(
      [{ event_id: crypto.randomUUID(), payload }],
      { venueId, publicationId, jti },
      { enqueue },
    );
    expect(result.queueUnavailable).toBe(false);
    if (result.queueUnavailable) throw new Error('unexpected Queue failure');
    expect(result.response.receipts).toMatchObject([
      { status: 'rejected', reason_code: 'schema_invalid', retryable: false },
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('quarantines invalid same-metadata copies when their raw payload checksums differ', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const base = event();
    const first = { ...base, schema_version: 2, payload: { ...base.payload, shortlist_size: 1 } };
    const second = { ...base, schema_version: 2, payload: { ...base.payload, shortlist_size: 2 } };
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([first, second]),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).receipts).toMatchObject([
      { status: 'rejected', reason_code: 'event_id_conflict' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
    ]);
    const message = enqueueObservation.mock.calls[0]?.[0];
    expect(message.kind).toBe('observation_conflict.v1');
    expect(message.copies[0].canonicalChecksum).not.toBe(message.copies[1].canonicalChecksum);
    expect(JSON.stringify(message)).not.toContain('shortlist_size');
  });
  it('returns 503 when the conflict quarantine handoff is not confirmed', async () => {
    const valid = event();
    const response = await createApp({
      ...baseServices,
      enqueueObservation: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    }).fetch(request([valid, { ...valid, payload: { ...valid.payload, shortlist_size: 2 } }]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'queue_unavailable' });
  });
});

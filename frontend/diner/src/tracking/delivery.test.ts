import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeliver,
  type DeliveryResult,
  deliver,
  MAX_BATCH_EVENTS,
  type MenuToken,
  RETRY_CAP_MS,
  retryDelayMs,
} from './delivery';

// Shaped like the observation.v2 valid_events in PR #40's contract fixtures (synthetic data).
const NOW = Date.parse('2026-10-24T16:00:00.000Z');
const PUBLICATION = '40000000-0000-4000-8000-000000000001';
const OTHER_PUBLICATION = '40000000-0000-4000-8000-000000000002';
const ENDPOINT = 'https://api.example.test/observations';
const TOKEN: MenuToken = {
  value: 'test-token-a',
  expiresAt: NOW + 30 * 60 * 1000,
  publicationRevisionId: PUBLICATION,
};

function envelope(n: number, extra: Record<string, unknown> = {}, publication = PUBLICATION) {
  return Object.freeze({
    schema_version: 'observation.v2',
    event_id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'dish_saved',
    session_id: '20000000-0000-4000-8000-000000000001',
    producer_id: '30000000-0000-4000-8000-000000000001',
    local_sequence: n,
    occurred_at: '2026-10-24T16:00:00.000Z',
    publication_revision_id: publication,
    payload: {
      dish_id: '50000000-0000-4000-8000-000000000001',
      dish_revision_id: '60000000-0000-4000-8000-000000000001',
      save_origin: 'direct',
      save_surface: 'dish_detail',
      shortlist_size: 1,
      ...extra,
    },
  });
}

const id = (n: number) => envelope(n).event_id;

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { url: string; init: RequestInit; events: Array<{ event_id: string }> };

// A fake ingestion endpoint. `reply` decides the answer from the events in each request.
function fakeServer(
  reply: (events: Array<{ event_id: string }>, call: number) => Reply | 'offline',
) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { events: Array<{ event_id: string }> };
    calls.push({ url: String(url), init: init ?? {}, events: body.events });
    const answer = reply(body.events, calls.length);
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.headers ?? {},
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function receipts(
  events: Array<{ event_id: string }>,
  status: (id: string) => ['accepted' | 'retry' | 'rejected', string | null],
) {
  return {
    status: 200,
    body: {
      contract: 'observation-receipt.v1',
      request_id: 'a0000000-0000-4000-8000-000000000001',
      receipts: events.map(({ event_id }) => {
        const [s, reason] = status(event_id);
        return { event_id, status: s, reason_code: reason, retryable: s === 'retry' };
      }),
    },
  };
}

const accepted = (events: Array<{ event_id: string }>) =>
  receipts(events, () => ['accepted', null]);

function options(fetch: typeof globalThis.fetch, token: MenuToken | null = TOKEN, now = NOW) {
  return { endpoint: ENDPOINT, fetch, now: () => now, token: () => token };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deliver', () => {
  it('removes an event on a valid first delivery (accepted)', async () => {
    const server = fakeServer(accepted);
    const result = await deliver([envelope(1)], options(server.fetch));
    expect(result).toEqual({
      done: [id(1)],
      retry: [],
      retryAfterMs: null,
      counts: expect.objectContaining({ accepted: 1 }),
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(server.calls[0]?.init.body))).toEqual({
      contract: 'observation.v2',
      events: [envelope(1)],
    });
  });

  it('puts the token only in the Authorization header, never the URL, body or logs', async () => {
    const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const server = fakeServer(accepted);
    await deliver([envelope(1)], options(server.fetch));
    const call = server.calls[0];
    expect(new Headers(call?.init.headers).get('Authorization')).toBe(`Bearer ${TOKEN.value}`);
    expect(call?.url).not.toContain(TOKEN.value);
    expect(String(call?.init.body)).not.toContain(TOKEN.value);
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('removes an identical retry answered as a duplicate with the same payload', async () => {
    const server = fakeServer((events) =>
      receipts(events, () => ['accepted', 'duplicate_same_payload']),
    );
    const result = await deliver([envelope(1)], options(server.fetch));
    expect(result.done).toEqual([id(1)]);
    expect(result.retry).toEqual([]);
  });

  it('drops an event rejected as an event_id conflict and does not retry it', async () => {
    const server = fakeServer((events) =>
      receipts(events, () => ['rejected', 'event_id_conflict']),
    );
    const result = await deliver([envelope(1)], options(server.fetch));
    expect(result.done).toEqual([id(1)]);
    expect(result.retry).toEqual([]);
    expect(result.counts.rejected).toBe(1);
  });

  it('handles a mixed batch per event', async () => {
    const server = fakeServer((events) =>
      receipts(events, (eventId) =>
        eventId === id(1)
          ? ['accepted', null]
          : eventId === id(2)
            ? ['rejected', 'too_old']
            : ['retry', null],
      ),
    );
    const result = await deliver([envelope(1), envelope(2), envelope(3)], options(server.fetch));
    expect(server.calls).toHaveLength(1);
    expect(result.done).toEqual([id(1), id(2)]);
    expect(result.retry).toEqual([id(3)]);
    expect(result.counts).toMatchObject({ accepted: 1, rejected: 1 });
  });

  it('reads an unidentified schema_invalid rejection by its position', async () => {
    const server = fakeServer((events) => ({
      status: 200,
      body: {
        contract: 'observation-receipt.v1',
        request_id: 'a0000000-0000-4000-8000-000000000001',
        receipts: [
          { event_id: null, status: 'rejected', reason_code: 'schema_invalid', retryable: false },
          {
            event_id: events[1]?.event_id,
            status: 'accepted',
            reason_code: null,
            retryable: false,
          },
        ],
      },
    }));
    const result = await deliver([envelope(1), envelope(2)], options(server.fetch));
    expect(result.done).toEqual([id(1), id(2)]);
    expect(result.counts).toMatchObject({ accepted: 1, rejected: 1 });
  });

  it('keeps everything for a retry when offline, on 503 or on an unreadable answer', async () => {
    for (const reply of [
      () => 'offline' as const,
      () => ({ status: 503, body: { error: 'queue_unavailable' } }),
      () => ({ status: 200, body: { unexpected: true } }),
    ]) {
      const result = await deliver([envelope(1), envelope(2)], options(fakeServer(reply).fetch));
      expect(result.done).toEqual([]);
      expect(result.retry).toEqual([id(1), id(2)]);
    }
  });

  it('retries with the same event_id and payload until it is accepted', async () => {
    const server = fakeServer((events, call) => (call === 1 ? { status: 503 } : accepted(events)));
    const first = await deliver([envelope(1)], options(server.fetch));
    expect(first.retry).toEqual([id(1)]);
    const second = await deliver([envelope(1)], options(server.fetch));
    expect(second.done).toEqual([id(1)]);
    expect(server.calls[1]?.init.body).toBe(server.calls[0]?.init.body);
  });

  it('keeps a rate-limited batch and passes on Retry-After', async () => {
    const server = fakeServer(() => ({ status: 429, headers: { 'Retry-After': '7' } }));
    const result = await deliver([envelope(1)], options(server.fetch));
    expect(result.retry).toEqual([id(1)]);
    expect(result.retryAfterMs).toBe(7000);
  });

  it('never resends an unreadable envelope (400) or a refused token (401)', async () => {
    const bad = await deliver([envelope(1)], options(fakeServer(() => ({ status: 400 })).fetch));
    expect(bad.done).toEqual([id(1)]);
    expect(bad.counts.clientInvalid).toBe(1);
    const refused = await deliver(
      [envelope(1)],
      options(fakeServer(() => ({ status: 401 })).fetch),
    );
    expect(refused.done).toEqual([id(1)]);
    expect(refused.counts.unauthorized).toBe(1);
  });

  it('halves a batch on 413 and drops a single event that is still too large', async () => {
    const server = fakeServer((events) =>
      events.some((e) => e.event_id === id(2)) ? { status: 413 } : accepted(events),
    );
    const result = await deliver([envelope(1), envelope(2), envelope(3)], options(server.fetch));
    expect(server.calls.map((c) => c.events.length)).toEqual([3, 2, 1, 1, 1]);
    expect([...result.done].sort()).toEqual([id(1), id(2), id(3)].sort());
    expect(result.counts).toMatchObject({ accepted: 2, payloadTooLarge: 1 });
  });

  it('splits batches over 25 events or 32 KiB before sending', async () => {
    const server = fakeServer(accepted);
    const many = Array.from({ length: MAX_BATCH_EVENTS + 5 }, (_, i) => envelope(i + 1));
    await deliver(many, options(server.fetch));
    expect(server.calls.map((c) => c.events.length)).toEqual([25, 5]);

    const heavy = fakeServer(accepted);
    const padding = 'x'.repeat(12_000);
    await deliver(
      [1, 2, 3].map((n) => envelope(n, { note: padding })),
      options(heavy.fetch),
    );
    for (const call of heavy.calls) {
      expect(new TextEncoder().encode(String(call.init.body)).length).toBeLessThanOrEqual(
        32 * 1024,
      );
    }
  });

  it('never relabels: events from another publication are dropped unsent and counted', async () => {
    const server = fakeServer(accepted);
    const result = await deliver(
      [envelope(1), envelope(2, {}, OTHER_PUBLICATION)],
      options(server.fetch),
    );
    expect(result.done).toEqual([id(2), id(1)]);
    expect(result.counts).toMatchObject({ expired: 1, accepted: 1 });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.events.map((e) => e.event_id)).toEqual([id(1)]);
  });

  it('drops events unsent once the menu token has expired', async () => {
    const server = fakeServer(accepted);
    const expired: MenuToken = { ...TOKEN, expiresAt: NOW };
    const result = await deliver([envelope(1), envelope(2)], options(server.fetch, expired));
    expect(result.done).toEqual([id(1), id(2)]);
    expect(result.counts.expired).toBe(2);
    expect(server.calls).toHaveLength(0);
  });

  it('keeps everything and sends nothing before a menu token exists', async () => {
    const server = fakeServer(accepted);
    const result = await deliver([envelope(1)], options(server.fetch, null));
    expect(result).toMatchObject({ done: [], retry: [id(1)] });
    expect(server.calls).toHaveLength(0);
  });
});

describe('createDeliver', () => {
  it('resolves to the event_ids that leave the outbox and reports the full result', async () => {
    const server = fakeServer((events) =>
      receipts(events, (eventId) => (eventId === id(1) ? ['accepted', null] : ['retry', null])),
    );
    const results: DeliveryResult[] = [];
    const send = createDeliver(options(server.fetch), (r) => results.push(r));
    expect(await send([envelope(1), envelope(2)])).toEqual([id(1)]);
    expect(results[0]?.retry).toEqual([id(2)]);
  });

  it('still resolves when the result callback throws', async () => {
    const send = createDeliver(options(fakeServer(accepted).fetch), () => {
      throw new Error('dev log failed');
    });
    expect(await send([envelope(1)])).toEqual([id(1)]);
  });
});

describe('retryDelayMs', () => {
  it('doubles from 1 second with jitter and caps at 60 seconds', () => {
    const top = () => 1;
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, null, top))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(1, null, () => 0)).toBe(500);
    expect(retryDelayMs(20, null, top)).toBe(RETRY_CAP_MS);
  });

  it('never waits less than the server Retry-After', () => {
    expect(retryDelayMs(1, 7000, () => 1)).toBe(7000);
  });
});

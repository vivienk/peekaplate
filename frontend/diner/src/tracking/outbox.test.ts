import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTrackingAllowed, setTrackingAllowed } from './consent';
import type { Envelope } from './envelope';
import {
  createOutbox,
  localStorageOutboxStore,
  MAX_EVENT_AGE_MS,
  memoryOutboxStore,
  OUTBOX_MAX_BYTES,
  OUTBOX_MAX_EVENTS,
} from './outbox';

const NOW = Date.UTC(2026, 10, 1, 12);

let seq = 0;
function envelope(occurredAt = NOW, extra: Record<string, unknown> = {}): Envelope {
  seq += 1;
  return Object.freeze({
    schema_version: 'observation.v2',
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    type: 'menu_viewed',
    session_id: 'a0000000-0000-4000-8000-000000000001',
    producer_id: 'b0000000-0000-4000-8000-000000000001',
    local_sequence: seq,
    occurred_at: new Date(occurredAt).toISOString(),
    publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
    payload: Object.freeze({ entry_source: 'qr', ...extra }),
  });
}

afterEach(() => {
  setTrackingAllowed(false);
  vi.restoreAllMocks();
});

describe('consent gate', () => {
  it('is off by default and can be switched on from one place', () => {
    expect(isTrackingAllowed()).toBe(false);
    setTrackingAllowed(true);
    expect(isTrackingAllowed()).toBe(true);
  });
});

describe('outbox', () => {
  it('keeps events in order, unchanged, including their session and producer IDs', async () => {
    const outbox = await createOutbox(memoryOutboxStore(), { now: () => NOW });
    const a = envelope();
    const b = envelope();
    await outbox.add(a);
    await outbox.add(b);
    expect(outbox.pending()).toEqual([a, b]);
  });

  it('survives a reload through its store', async () => {
    const store = memoryOutboxStore();
    const first = await createOutbox(store, { now: () => NOW });
    const a = envelope();
    await first.add(a);
    const reloaded = await createOutbox(store, { now: () => NOW });
    expect(reloaded.pending()).toEqual([a]);
  });

  it('removes only the events it is told were handled', async () => {
    const outbox = await createOutbox(memoryOutboxStore(), { now: () => NOW });
    const a = envelope();
    const b = envelope();
    await outbox.add(a);
    await outbox.add(b);
    await outbox.remove([a.event_id]);
    expect(outbox.pending()).toEqual([b]);
  });

  it('drops events older than 24 hours instead of keeping them', async () => {
    const store = memoryOutboxStore();
    const old = envelope(NOW - MAX_EVENT_AGE_MS - 1);
    const fresh = envelope(NOW - 1000);
    await store.save([old, fresh]);
    const outbox = await createOutbox(store, { now: () => NOW });
    expect(outbox.pending()).toEqual([fresh]);
    await outbox.add(envelope(NOW - MAX_EVENT_AGE_MS - 1));
    expect(outbox.pending()).toEqual([fresh]);
  });

  it('drops the oldest events past 500, warning only through the developer callback', async () => {
    const warn = vi.fn();
    const outbox = await createOutbox(memoryOutboxStore(), { now: () => NOW, warn });
    const events = Array.from({ length: OUTBOX_MAX_EVENTS + 3 }, () => envelope());
    for (const event of events) await outbox.add(event);
    expect(outbox.pending()).toHaveLength(OUTBOX_MAX_EVENTS);
    expect(outbox.pending()[0]).toBe(events[3]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('drops the oldest events past 1 MiB', async () => {
    const outbox = await createOutbox(memoryOutboxStore(), { now: () => NOW, warn: () => {} });
    const big = 'x'.repeat(200 * 1024);
    for (let n = 0; n < 6; n++) await outbox.add(envelope(NOW, { note: big }));
    expect(outbox.bytes()).toBeLessThanOrEqual(OUTBOX_MAX_BYTES);
    expect(outbox.pending().length).toBeLessThan(6);
  });

  it('keeps working in memory when its store fails', async () => {
    const failing = {
      load: () => Promise.reject(new Error('blocked')),
      save: () => Promise.reject(new Error('full')),
    };
    const outbox = await createOutbox(failing, { now: () => NOW });
    const a = envelope();
    await expect(outbox.add(a)).resolves.toBeUndefined();
    expect(outbox.pending()).toEqual([a]);
  });
});

describe('localStorage store', () => {
  class FakeLocal {
    readonly values = new Map<string, string>();
    getItem(key: string) {
      return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      this.values.set(key, value);
    }
    removeItem(key: string) {
      this.values.delete(key);
    }
  }

  it('round-trips events and starts empty on damaged data', async () => {
    const local = new FakeLocal();
    const store = localStorageOutboxStore(local);
    const a = envelope();
    await store.save([a]);
    expect(await store.load()).toEqual([a]);
    local.values.set([...local.values.keys()][0] ?? '', '{nope');
    expect(await store.load()).toEqual([]);
  });
});

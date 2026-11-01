import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_ITEMS,
  type BatchTriggers,
  batchBody,
  createBatcher,
  FLUSH_EVERY_MS,
} from './batcher';
import type { Envelope } from './envelope';
import { createOutbox, memoryOutboxStore } from './outbox';

let seq = 0;
function envelope(note = ''): Envelope {
  seq += 1;
  return Object.freeze({
    schema_version: 'observation.v2',
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    type: 'menu_viewed',
    session_id: 'a0000000-0000-4000-8000-000000000001',
    producer_id: 'b0000000-0000-4000-8000-000000000001',
    local_sequence: seq,
    occurred_at: new Date().toISOString(),
    publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
    payload: Object.freeze({ entry_source: 'qr', ...(note ? { note } : {}) }),
  });
}

function fakeTriggers() {
  let online = true;
  const hidden: (() => void)[] = [];
  const back: (() => void)[] = [];
  const triggers: BatchTriggers = {
    isOnline: () => online,
    onHidden: (fn) => {
      hidden.push(fn);
      return () => {};
    },
    onOnline: (fn) => {
      back.push(fn);
      return () => {};
    },
  };
  return {
    triggers,
    hide: () => hidden.forEach((fn) => fn()),
    goOffline: () => {
      online = false;
    },
    goOnline: () => {
      online = true;
      back.forEach((fn) => fn());
    },
  };
}

async function setup(count: number, note = '') {
  const outbox = await createOutbox(memoryOutboxStore(), { now: () => Date.now() });
  for (let n = 0; n < count; n++) await outbox.add(envelope(note));
  const batches: Envelope[][] = [];
  const deliver = vi.fn(async (batch: Envelope[]) => {
    batches.push(batch);
    return batch.map((event) => event.event_id);
  });
  const page = fakeTriggers();
  const batcher = createBatcher(outbox, { deliver, triggers: page.triggers });
  return { outbox, batches, deliver, page, batcher };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('batching', () => {
  it('sends batches of at most 25 events, oldest first, on a timer', async () => {
    const { batches, outbox } = await setup(30);
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);
    expect(batches[0]).toHaveLength(BATCH_MAX_ITEMS);
    expect(batches[0]?.[0]?.local_sequence).toBeLessThan(batches[0]?.[24]?.local_sequence ?? 0);
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);
    expect(batches[1]).toHaveLength(5);
    expect(outbox.pending()).toEqual([]);
  });

  it('keeps each full request body, wrapper included, within 32,768 bytes', async () => {
    const { batches } = await setup(10, 'x'.repeat(5 * 1024));
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);
    const body = JSON.stringify(batchBody(batches[0] ?? []));
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(BATCH_MAX_BYTES);
    expect(batches[0]?.length).toBeLessThan(10);
  });

  it('uses the observation.v2 wire shape from the ingestion contract', () => {
    expect(BATCH_MAX_BYTES).toBe(32_768);
    expect(BATCH_MAX_ITEMS).toBe(25);
    expect(JSON.parse(JSON.stringify(batchBody([])))).toEqual({
      contract: 'observation.v2',
      events: [],
    });
  });

  it('fills a batch until the next event would push the full body past the limit', async () => {
    const { batches, outbox, deliver } = await setup(10, 'x'.repeat(5 * 1024));
    deliver.mockImplementation(async (batch: Envelope[]) => {
      batches.push(batch);
      return []; // Keep everything queued so the next waiting event can be inspected.
    });
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);
    const size = (events: Envelope[]) =>
      new TextEncoder().encode(JSON.stringify(batchBody(events))).byteLength;
    const batch = batches[0] ?? [];
    const next = outbox.pending()[batch.length];
    expect(next).toBeDefined();
    expect(size(batch)).toBeLessThanOrEqual(BATCH_MAX_BYTES);
    expect(size([...batch, ...(next ? [next] : [])])).toBeGreaterThan(BATCH_MAX_BYTES);
  });

  it('counts the contract wrapper: two events just 1-2 bytes over the limit go separately', async () => {
    const noted = (id: number, n: number): Envelope =>
      Object.freeze({
        ...envelope(),
        event_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
        local_sequence: id,
        payload: Object.freeze({ entry_source: 'qr', note: 'x'.repeat(n) }),
      });
    const bytes = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).byteLength;
    const pairSize = (n: number) => bytes(batchBody([noted(1, n), noted(2, n)]));
    // Each extra note character adds one byte per event, so this lands at 32,769 or 32,770 bytes.
    const n = Math.ceil((BATCH_MAX_BYTES + 1 - pairSize(0)) / 2);
    const pair = [noted(1, n), noted(2, n)];
    expect(bytes(batchBody(pair))).toBeGreaterThan(BATCH_MAX_BYTES);
    expect(bytes(batchBody(pair)) - BATCH_MAX_BYTES).toBeLessThanOrEqual(2);
    // The old { items } wrapper is shorter, so the same pair would wrongly fit under it.
    expect(bytes({ items: pair })).toBeLessThanOrEqual(BATCH_MAX_BYTES);

    const outbox = await createOutbox(memoryOutboxStore(), { now: () => Date.now() });
    for (const event of pair) await outbox.add(event);
    const batches: Envelope[][] = [];
    createBatcher(outbox, {
      deliver: async (batch) => {
        batches.push(batch);
        return batch.map((event) => event.event_id);
      },
      triggers: fakeTriggers().triggers,
    });
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
  });

  it('flushes the current batch when the page is hidden or closed', async () => {
    const { batches, page } = await setup(3);
    page.hide();
    await settle();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('waits while offline and releases the events on reconnect', async () => {
    const { batches, page, outbox } = await setup(2);
    page.goOffline();
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 3);
    page.hide();
    await settle();
    expect(batches).toEqual([]);
    expect(outbox.pending()).toHaveLength(2);
    page.goOnline();
    await settle();
    expect(batches[0]).toHaveLength(2);
  });

  it('removes only the events the sender reports as handled', async () => {
    const { outbox, deliver } = await setup(3);
    deliver.mockImplementation(async (batch: Envelope[]) => [batch[0]?.event_id ?? '']);
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);
    expect(outbox.pending()).toHaveLength(2);
  });

  it('keeps every event when sending fails', async () => {
    const { outbox, deliver } = await setup(3);
    deliver.mockRejectedValue(new Error('network down'));
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);
    expect(outbox.pending()).toHaveLength(3);
  });

  it('never runs two flushes at once', async () => {
    const { deliver, page } = await setup(30);
    let release: () => void = () => {};
    deliver.mockImplementation(
      (batch: Envelope[]) =>
        new Promise((resolve) => {
          release = () => resolve(batch.map((event) => event.event_id));
        }),
    );
    page.hide();
    page.hide();
    await settle();
    expect(deliver).toHaveBeenCalledOnce();
    release();
  });
});

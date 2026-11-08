import { afterEach, expect, it, vi } from 'vitest';
import { FLUSH_EVERY_MS } from './batcher';
import type { Envelope } from './envelope';
import { createOutbox, memoryOutboxStore } from './outbox';

const payload = {
  publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
  entry_source: 'qr',
};

it('a failed cold-page clear is retried before durable records can be reopened', async () => {
  const { tracking, store, batches, deliver } = await setup();
  const queued = await createOutbox(store, { now: Date.now });
  await queued.add({
    schema_version: 'observation.v2',
    event_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    producer_id: crypto.randomUUID(),
    local_sequence: 1,
    type: 'menu_viewed',
    occurred_at: new Date().toISOString(),
    publication_revision_id: payload.publication_revision_id,
    payload: { entry_source: 'qr' },
  });
  const update = store.update.bind(store);
  vi.spyOn(store, 'update')
    .mockRejectedValueOnce(new Error('temporary transaction abort'))
    .mockImplementation(update);
  tracking.setTrackingAllowed(false);
  tracking.enableLiveTracking(deliver);
  tracking.setTrackingAllowed(true);
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
  expect(batches).toEqual([]);
  expect(await store.load()).toEqual([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('./outbox');
  vi.resetModules();
});

async function setup(held = false) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.resetModules();
  const store = memoryOutboxStore();
  let release!: () => void;
  const ready = held
    ? new Promise<typeof store>((resolve) => {
        release = () => resolve(store);
      })
    : Promise.resolve(store);
  vi.doMock('./outbox', async () => ({
    ...(await vi.importActual<typeof import('./outbox')>('./outbox')),
    browserOutboxStore: () => ready,
  }));
  const tracking = await import('./index');
  const batches: Envelope[][] = [];
  const deliver = async (batch: Envelope[]) => {
    batches.push(batch);
    return batch.map((event) => event.event_id);
  };
  return { tracking, store, release, batches, deliver };
}

it('withdrawal on a cold page clears persisted work before re-opt-in', async () => {
  const { tracking, store, batches, deliver } = await setup();
  const queued = await createOutbox(store, { now: Date.now });
  await queued.add({
    schema_version: 'observation.v2',
    event_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    producer_id: crypto.randomUUID(),
    local_sequence: 1,
    type: 'menu_viewed',
    occurred_at: new Date().toISOString(),
    publication_revision_id: payload.publication_revision_id,
    payload: { entry_source: 'qr' },
  });
  tracking.setTrackingAllowed(false);
  tracking.enableLiveTracking(deliver);
  tracking.setTrackingAllowed(true);
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
  expect(batches).toEqual([]);
  expect(await store.load()).toEqual([]);
});

it('uses memory for new work if durable withdrawal keeps failing', async () => {
  const { tracking, store, batches, deliver } = await setup();
  const queued = await createOutbox(store, { now: Date.now });
  const oldId = crypto.randomUUID();
  await queued.add({
    schema_version: 'observation.v2',
    event_id: oldId,
    session_id: crypto.randomUUID(),
    producer_id: crypto.randomUUID(),
    local_sequence: 1,
    type: 'menu_viewed',
    occurred_at: new Date().toISOString(),
    publication_revision_id: payload.publication_revision_id,
    payload: { entry_source: 'qr' },
  });
  vi.spyOn(store, 'update').mockRejectedValue(new Error('storage unavailable'));
  tracking.setTrackingAllowed(false);
  tracking.enableLiveTracking(deliver);
  tracking.setTrackingAllowed(true);
  tracking.track('menu_viewed', payload);
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
  expect(batches.flat()).toHaveLength(1);
  expect(batches.flat().some((event) => event.event_id === oldId)).toBe(false);
});

it('queued full-batch additions cannot cross withdrawal and re-opt-in during store initialization', async () => {
  const { tracking, store, release, batches, deliver } = await setup(true);
  tracking.enableLiveTracking(deliver);
  tracking.setTrackingAllowed(true);
  for (let n = 0; n < 25; n++) tracking.track('menu_viewed', payload);
  tracking.setTrackingAllowed(false);
  tracking.setTrackingAllowed(true);
  release();
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
  expect(batches).toEqual([]);
  expect(await store.load()).toEqual([]);
  tracking.track('menu_viewed', payload);
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);
  expect(batches.flat()).toHaveLength(1);
});

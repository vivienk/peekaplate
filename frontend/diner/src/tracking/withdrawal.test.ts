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
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function setup(held = false) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.resetModules();
  for (const name of ['sessionStorage', 'localStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  }
  const store = memoryOutboxStore();
  let release!: () => void;
  const ready = held
    ? new Promise<typeof store>((resolve) => {
        release = () => resolve(store);
      })
    : Promise.resolve(store);
  const open = vi.fn(() => ready);
  const clear = vi.fn(async () => {
    await store.update(() => []);
  });
  vi.doMock('./outbox', async () => ({
    ...(await vi.importActual<typeof import('./outbox')>('./outbox')),
    browserOutboxStore: open,
    clearBrowserOutboxes: clear,
  }));
  const tracking = await import('./index');
  const batches: Envelope[][] = [];
  const deliver = async (batch: Envelope[]) => {
    batches.push(batch);
    return batch.map((event) => event.event_id);
  };
  return { tracking, store, release, batches, deliver, open, clear };
}

function oldEvent(): Envelope {
  return {
    schema_version: 'observation.v2',
    event_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    producer_id: crypto.randomUUID(),
    local_sequence: 1,
    type: 'menu_viewed',
    occurred_at: new Date().toISOString(),
    publication_revision_id: payload.publication_revision_id,
    payload: { entry_source: 'qr' },
  };
}

it('retries a failed withdrawal after a fresh page module opens the same storage', async () => {
  const { tracking, store, batches, deliver } = await setup();
  await store.update(() => [oldEvent()]);
  const update = store.update.bind(store);
  vi.spyOn(store, 'update')
    .mockRejectedValueOnce(new Error('temporary storage failure'))
    .mockImplementation(update);
  tracking.setTrackingAllowed(false);
  await vi.advanceTimersByTimeAsync(1);
  vi.resetModules();
  const reloaded = await import('./index');
  reloaded.enableLiveTracking(deliver);
  reloaded.setTrackingAllowed(true);
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
  expect(batches).toEqual([]);
  expect(await store.load()).toEqual([]);
});

it('a memory fallback clear cannot confirm that a recovered durable backend was cleared', async () => {
  const { tracking, store, batches, deliver, open, clear } = await setup();
  await store.update(() => [oldEvent()]);
  open.mockResolvedValueOnce(memoryOutboxStore());
  clear.mockRejectedValueOnce(new Error('durable backend cannot open'));
  tracking.setTrackingAllowed(false);
  await vi.advanceTimersByTimeAsync(1);
  tracking.enableLiveTracking(deliver);
  tracking.setTrackingAllowed(true);
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
  expect(batches).toEqual([]);
  expect(await store.load()).toEqual([]);
});

it('an older clear completion cannot mark a newer withdrawal complete', async () => {
  const { clear } = await setup();
  let finish!: () => void;
  clear.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const withdrawal = await import('./withdrawal');
  withdrawal.markWithdrawal();
  const oldClear = withdrawal.clearPendingWithdrawal();
  withdrawal.markWithdrawal();
  finish();
  await oldClear;
  expect(withdrawal.hasPendingWithdrawal()).toBe(true);
  vi.resetModules();
  const reloaded = await import('./withdrawal');
  expect(reloaded.hasPendingWithdrawal()).toBe(true);
  await reloaded.clearPendingWithdrawal();
  expect(reloaded.hasPendingWithdrawal()).toBe(false);
});

it('unreadable markers still attempt backend clearance and keep new work in memory', async () => {
  const { tracking, store, batches, deliver, clear } = await setup();
  const old = oldEvent();
  await store.update(() => [old]);
  const local = globalThis.localStorage;
  vi.spyOn(local, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  tracking.setTrackingAllowed(false);
  tracking.enableLiveTracking(deliver);
  tracking.setTrackingAllowed(true);
  tracking.track('menu_viewed', payload);
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2);
  expect(clear).toHaveBeenCalled();
  expect(await store.load()).toEqual([]);
  expect(batches.flat()).toHaveLength(1);
  expect(batches.flat()[0]?.event_id).not.toBe(old.event_id);
});

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

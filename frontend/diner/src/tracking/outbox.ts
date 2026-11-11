// Canonical-only outbox. Shared stores mutate the latest record atomically, never a tab snapshot.
import type { Envelope } from './envelope';

export const OUTBOX_MAX_EVENTS = 500;
export const OUTBOX_MAX_BYTES = 1024 * 1024;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

type Change = (events: Envelope[]) => Envelope[];
export type OutboxStore = {
  load(): Promise<Envelope[]>;
  update(change: Change): Promise<Envelope[]>;
};

const encoder = new TextEncoder();
const sizeOf = (event: Envelope) => encoder.encode(JSON.stringify(event)).length;
const isEnvelopeList = (value: unknown): value is Envelope[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.event_id === 'string' &&
      typeof item.occurred_at === 'string',
  );

export function memoryOutboxStore(): OutboxStore {
  let saved: Envelope[] = [];
  return {
    load: async () => [...saved],
    async update(change) {
      saved = change([...saved]);
      return [...saved];
    },
  };
}

const LOCAL_KEY = 'peekaplate:tracking:outbox:v1';
const LOCK_NAME = 'peekaplate:tracking:outbox';

export function localStorageOutboxStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  locks: Pick<LockManager, 'request'> | undefined = globalThis.navigator?.locks,
): OutboxStore {
  // Without cross-tab locking, memory is safer than silently overwriting another tab's events.
  if (!locks) return memoryOutboxStore();
  const read = () => {
    const raw = storage.getItem(LOCAL_KEY);
    try {
      const value: unknown = JSON.parse(raw ?? '[]');
      return isEnvelopeList(value) ? value : [];
    } catch {
      return [];
    }
  };
  return {
    load: async () => locks.request(LOCK_NAME, () => read()),
    update: async (change) =>
      locks.request(LOCK_NAME, () => {
        const next = change(read());
        storage.setItem(LOCAL_KEY, JSON.stringify(next));
        return next;
      }),
  };
}

const DB_NAME = 'peekaplate-tracking';
const DB_STORE = 'outbox';

export async function indexedDbOutboxStore(factory: IDBFactory): Promise<OutboxStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  db.onversionchange = () => db.close();
  const run = (change?: Change) =>
    new Promise<Envelope[]>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, change ? 'readwrite' : 'readonly');
      const store = tx.objectStore(DB_STORE);
      let result: Envelope[] = [];
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Outbox transaction aborted'));
      const get = store.get('events');
      get.onsuccess = () => {
        try {
          const latest = isEnvelopeList(get.result) ? get.result : [];
          result = change ? change(latest) : latest;
          if (change) store.put(result, 'events');
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
    });
  return { load: () => run(), update: (change) => run(change) };
}

export async function browserOutboxStore(): Promise<OutboxStore> {
  try {
    if (globalThis.indexedDB) return await indexedDbOutboxStore(globalThis.indexedDB);
  } catch {}
  try {
    const local = globalThis.localStorage;
    if (local) {
      const probe = `${LOCAL_KEY}:probe`;
      local.setItem(probe, '1');
      local.removeItem(probe);
      return localStorageOutboxStore(local);
    }
  } catch {}
  return memoryOutboxStore();
}

// A fallback opening successfully says nothing about records left in the other backend.
export async function clearBrowserOutboxes(): Promise<void> {
  let failed = false;
  try {
    if (globalThis.indexedDB) {
      await (await indexedDbOutboxStore(globalThis.indexedDB)).update(() => []);
    }
  } catch {
    failed = true;
  }
  try {
    const local = globalThis.localStorage;
    if (local) {
      const locks = globalThis.navigator?.locks;
      if (locks) await locks.request(LOCK_NAME, () => local.removeItem(LOCAL_KEY));
      else if (local.getItem(LOCAL_KEY) !== null) failed = true;
    }
  } catch {
    failed = true;
  }
  if (failed) throw new Error('Tracking outbox clearance is incomplete');
}

export async function createOutbox(
  store: OutboxStore,
  { now, warn = () => {} }: { now: () => number; warn?: (message: string) => void },
) {
  let events: Envelope[] = [];
  let durable = true;
  const fresh = (event: Envelope) => now() - Date.parse(event.occurred_at) <= MAX_EVENT_AGE_MS;
  function enforceLimits(latest: Envelope[]): Envelope[] {
    const kept = latest.filter(fresh);
    let bytes = kept.reduce((total, event) => total + sizeOf(event), 0);
    while (kept.length > OUTBOX_MAX_EVENTS || (bytes > OUTBOX_MAX_BYTES && kept.length > 0)) {
      const dropped = kept.shift();
      if (dropped) bytes -= sizeOf(dropped);
      warn('Tracking outbox full: dropped the oldest event');
    }
    return kept;
  }
  async function mutate(change: Change): Promise<Envelope[]> {
    if (durable) {
      try {
        events = await store.update((latest) => enforceLimits(change(latest)));
        return [...events];
      } catch {
        durable = false;
        events = [];
      }
    }
    // Do not revive a stale shared snapshot when storage fails; retain only this visit's new work.
    events = enforceLimits(change(events));
    return [...events];
  }
  await mutate((latest) => latest);
  return {
    async add(event: Envelope, allowed: () => boolean = () => true) {
      if (!fresh(event)) return;
      await mutate((latest) =>
        allowed() && !latest.some((item) => item.event_id === event.event_id)
          ? [...latest, event]
          : latest,
      );
    },
    async remove(eventIds: string[]) {
      const done = new Set(eventIds);
      await mutate((latest) => latest.filter((event) => !done.has(event.event_id)));
    },
    // Re-read shared state before sending so another tab's receipt or withdrawal takes effect.
    pending: () => mutate((latest) => latest),
    bytes: () => events.reduce((total, event) => total + sizeOf(event), 0),
    async clear() {
      events = [];
      // Reopening must know if the durable withdrawal failed, even after a memory fallback.
      await store.update(() => []);
    },
  };
}

export type Outbox = Awaited<ReturnType<typeof createOutbox>>;

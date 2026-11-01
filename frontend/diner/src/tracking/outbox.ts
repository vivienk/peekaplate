// The durable outbox (S3-TRK-01.2): events are stored before any send, so a reload, crash or
// offline spell does not lose them. Limits follow matrix v0.1h (Adam, 31 Oct): at most 500 events
// and 1 MiB, and nothing older than 24 hours. Overflow drops the oldest events, with a warning in
// developer builds only. Records are stored unchanged, so each keeps its original session_id,
// producer_id and event_id for retries. Storage failures never reach the UI.
import type { Envelope } from './envelope';

export const OUTBOX_MAX_EVENTS = 500;
export const OUTBOX_MAX_BYTES = 1024 * 1024;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

// The whole list is read and written at once: at most 500 events, so each save stays small.
export type OutboxStore = { load(): Promise<Envelope[]>; save(events: Envelope[]): Promise<void> };

const encoder = new TextEncoder();
const sizeOf = (event: Envelope) => encoder.encode(JSON.stringify(event)).length;

const isEnvelopeList = (value: unknown): value is Envelope[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Envelope).event_id === 'string' &&
      typeof (item as Envelope).occurred_at === 'string',
  );

export function memoryOutboxStore(): OutboxStore {
  let saved: Envelope[] = [];
  return {
    load: async () => [...saved],
    save: async (events) => {
      saved = [...events];
    },
  };
}

const LOCAL_KEY = 'peekaplate:tracking:outbox:v1';

export function localStorageOutboxStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): OutboxStore {
  return {
    async load() {
      try {
        const value: unknown = JSON.parse(storage.getItem(LOCAL_KEY) ?? '[]');
        return isEnvelopeList(value) ? value : [];
      } catch {
        return [];
      }
    },
    async save(events) {
      storage.setItem(LOCAL_KEY, JSON.stringify(events));
    },
  };
}

const DB_NAME = 'peekaplate-tracking';
const DB_STORE = 'outbox';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function indexedDbOutboxStore(factory: IDBFactory): Promise<OutboxStore> {
  const open = factory.open(DB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
  const db = await request(open);
  const run = <T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>) =>
    request(use(db.transaction(DB_STORE, mode).objectStore(DB_STORE)));
  return {
    async load() {
      const value: unknown = await run('readonly', (store) => store.get('events'));
      return isEnvelopeList(value) ? value : [];
    },
    async save(events) {
      await run('readwrite', (store) => store.put(events, 'events'));
    },
  };
}

// IndexedDB first, then localStorage, then memory (events kept for the visit only).
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

export async function createOutbox(
  store: OutboxStore,
  { now, warn = () => {} }: { now: () => number; warn?: (message: string) => void },
) {
  let events: Envelope[] = [];
  try {
    events = await store.load();
  } catch {}

  const fresh = (event: Envelope) => now() - Date.parse(event.occurred_at) <= MAX_EVENT_AGE_MS;

  function enforceLimits() {
    events = events.filter(fresh);
    let bytes = events.reduce((total, event) => total + sizeOf(event), 0);
    while (events.length > OUTBOX_MAX_EVENTS || (bytes > OUTBOX_MAX_BYTES && events.length > 0)) {
      const dropped = events.shift();
      if (dropped) bytes -= sizeOf(dropped);
      warn('Tracking outbox full: dropped the oldest event');
    }
  }

  // A failed save keeps the events in memory for this visit; it never throws to the caller.
  async function persist() {
    try {
      await store.save(events);
    } catch {}
  }

  enforceLimits();

  return {
    async add(event: Envelope) {
      if (!fresh(event)) return;
      events.push(event);
      enforceLimits();
      await persist();
    },
    // Called once an event has been handled (sent and receipted, or console-only in fixture mode).
    async remove(eventIds: string[]) {
      const done = new Set(eventIds);
      events = events.filter((event) => !done.has(event.event_id));
      await persist();
    },
    // Events still waiting, oldest first; anything that has aged past 24 hours is dropped first.
    pending(): Envelope[] {
      events = events.filter(fresh);
      return [...events];
    },
    bytes: () => events.reduce((total, event) => total + sizeOf(event), 0),
  };
}

export type Outbox = Awaited<ReturnType<typeof createOutbox>>;

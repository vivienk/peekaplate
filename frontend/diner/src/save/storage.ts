// Browser storage for saved dishes (S3-DIN-02.1). One key per restaurant, holding dish ids only:
// no names, prices, account or server. When storage is blocked or full, saving keeps working in
// memory for the rest of the visit ("session-only") and nothing is backfilled later.

export type SaveStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type SaveMode = 'persistent' | 'session-only';

type StoredSaves = { version: 1; dishIds: string[] };

const PROBE_KEY = 'peekaplate:saved:probe';

export function savedKey(venueId: string): string {
  return `peekaplate:saved:v1:${venueId}`;
}

// Reading localStorage itself can throw (for example when site data is blocked).
export function browserStorage(): SaveStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Some browsers expose storage but refuse writes, so only a real test write proves it works.
function canWrite(storage: SaveStorage): boolean {
  try {
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

// Damaged or unknown data starts an empty list rather than breaking the menu.
function parseSaved(raw: string | null): string[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const { version, dishIds } = value as Partial<Record<keyof StoredSaves, unknown>>;
  if (version !== 1 || !Array.isArray(dishIds)) return [];
  const ids = dishIds.filter((id): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)];
}

export function createSavedPersistence({
  venueId,
  storage = browserStorage(),
}: {
  venueId: string;
  storage?: SaveStorage | null;
}) {
  const key = savedKey(venueId);
  let mode: SaveMode = storage && canWrite(storage) ? 'persistent' : 'session-only';

  return {
    mode: (): SaveMode => mode,

    // Earlier saves are still read when only writing is blocked.
    load(): string[] {
      if (!storage) return [];
      try {
        return parseSaved(storage.getItem(key));
      } catch {
        return [];
      }
    },

    // The latest list another tab may have written, or null when storage can't be read right now,
    // so a failed read is never mistaken for "nothing saved".
    reread(): string[] | null {
      if (!storage) return null;
      try {
        return parseSaved(storage.getItem(key));
      } catch {
        return null;
      }
    },

    // True only when the write committed. A failed write switches to session-only for the rest
    // of the visit, and later writes are skipped so nothing is backfilled.
    persist(dishIds: readonly string[]): boolean {
      if (mode === 'session-only' || !storage) return false;
      const value: StoredSaves = { version: 1, dishIds: [...dishIds] };
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        mode = 'session-only';
        return false;
      }
    },
  };
}

export type SavedPersistence = ReturnType<typeof createSavedPersistence>;

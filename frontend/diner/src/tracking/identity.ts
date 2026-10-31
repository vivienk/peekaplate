// Per-tab, per-visit identity for observation.v2 (S3-TRK-01.1; Sai, 27 Oct; Zhiliang, 31 Oct).
// session_id and producer_id are random per visit and per tab; nothing identifies a device or
// person, and nothing outlives the visit. local_sequence is per producer: it starts at 1, a
// number is never reused, and it never restarts while the same producer_id is kept.
export type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type Lifecycle = { onHide(fn: () => void): void; onShow(fn: () => void): void };
export type EventIdentity = { sessionId: string; producerId: string; localSequence: number };

export const IDENTITY_KEY = 'peekaplate:tracking:identity:v1';
// A new visit starts after 30 minutes without activity (implementation plan, visit window).
// Tracked events stand in for activity until the visit coordinator reports it.
export const VISIT_TIMEOUT_MS = 30 * 60 * 1000;

type State = {
  version: 1;
  sessionId: string;
  producerId: string;
  nextSequence: number;
  lastActivityAt: number;
  // True while the page that owns this state is open. A browser that duplicates a tab copies
  // sessionStorage with this still true, which is how the copy knows the IDs are taken.
  open: boolean;
};

function readState(store: SessionStore | null): State | null {
  if (!store) return null;
  try {
    const value = JSON.parse(store.getItem(IDENTITY_KEY) ?? 'null') as Partial<State> | null;
    if (
      value?.version === 1 &&
      typeof value.sessionId === 'string' &&
      typeof value.producerId === 'string' &&
      Number.isSafeInteger(value.nextSequence) &&
      (value.nextSequence ?? 0) >= 1 &&
      typeof value.lastActivityAt === 'number' &&
      typeof value.open === 'boolean'
    ) {
      return value as State;
    }
  } catch {}
  return null;
}

// Uses sessionStorage, which belongs to one tab and is cleared when the tab closes. With storage
// blocked, identity lives in memory, so a reload starts a new visit (Zhiliang: acceptable).
export function createIdentity({
  store,
  uuid,
  now,
  lifecycle,
}: {
  store: SessionStore | null;
  uuid: () => string;
  now: () => number;
  lifecycle: Lifecycle;
}) {
  let persistent = store !== null;

  const fresh = (): State => ({
    version: 1,
    sessionId: uuid(),
    producerId: uuid(),
    nextSequence: 1,
    lastActivityAt: now(),
    open: true,
  });

  // Keep this tab's state: a reload in the same tab, not yet timed out, and not a copy of a tab
  // that is still open. Anything else (a duplicate, a crash, a long absence) is a new visit.
  const stored = readState(store);
  let state =
    stored && !stored.open && now() - stored.lastActivityAt < VISIT_TIMEOUT_MS
      ? { ...stored, open: true }
      : fresh();

  function save() {
    if (!persistent || !store) return;
    try {
      store.setItem(IDENTITY_KEY, JSON.stringify(state));
    } catch {
      // A stale stored copy could hand old sequence numbers to the same producer after a reload,
      // so drop it and carry on in memory.
      persistent = false;
      try {
        store.removeItem(IDENTITY_KEY);
      } catch {}
    }
  }

  save();
  lifecycle.onHide(() => {
    state = { ...state, open: false };
    save();
  });
  lifecycle.onShow(() => {
    state = { ...state, open: true };
    save();
  });

  return {
    // Call only for an event that passed validation, so a dropped event never uses a number.
    next(): EventIdentity {
      if (now() - state.lastActivityAt >= VISIT_TIMEOUT_MS) state = fresh();
      const localSequence = state.nextSequence;
      state = { ...state, nextSequence: localSequence + 1, lastActivityAt: now() };
      save();
      return { sessionId: state.sessionId, producerId: state.producerId, localSequence };
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;

// The real browser's tab storage; reading it can throw when site data is blocked.
export function browserSessionStore(): SessionStore | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

// pagehide fires when the page is left or reloaded; pageshow with persisted means it came back
// from the back-forward cache.
export function browserLifecycle(): Lifecycle {
  return {
    onHide: (fn) => globalThis.addEventListener('pagehide', fn),
    onShow: (fn) =>
      globalThis.addEventListener('pageshow', (event) => {
        if ((event as PageTransitionEvent).persisted) fn();
      }),
  };
}

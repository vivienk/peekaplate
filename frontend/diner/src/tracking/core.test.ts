import { describe, expect, it } from 'vitest';
import { buildEnvelope } from './envelope';
import { isAllowedEvent, P0_EVENT_NAMES } from './event-names';
import { createIdentity, IDENTITY_KEY, type SessionStore, VISIT_TIMEOUT_MS } from './identity';
import { newComparisonId, newExposureId, newOpeningId } from './ids';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLICATION = 'a5000000-0000-4000-8000-000000000001';
const DISH = 'a1000000-0000-4000-8000-000000000001';
const REVISION = 'a2000000-0000-4000-8000-000000000001';

class FakeSession implements SessionStore {
  readonly values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('blocked', 'SecurityError');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

// A page's lifecycle: pagehide when it is left or reloaded, pageshow when restored from cache.
function fakeLifecycle() {
  const hide: (() => void)[] = [];
  const show: (() => void)[] = [];
  return {
    lifecycle: {
      onHide: (fn: () => void) => hide.push(fn),
      onShow: (fn: () => void) => show.push(fn),
    },
    pagehide: () => {
      for (const fn of hide) fn();
    },
    pageshow: () => {
      for (const fn of show) fn();
    },
  };
}

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}${(n++).toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
}

// Each simulated tab gets its own ID prefix, like the random IDs a real browser makes.
let tabs = 0;
function tab(store: FakeSession | null, clock = { t: 0 }) {
  const page = fakeLifecycle();
  tabs += 1;
  const identity = createIdentity({
    store,
    uuid: counter(`${tabs.toString(16).padStart(4, '0')}`),
    now: () => clock.t,
    lifecycle: page.lifecycle,
  });
  return { identity, ...page, clock };
}

describe('allowlist', () => {
  it('accepts exactly the eight P0 event names', () => {
    expect(P0_EVENT_NAMES).toEqual([
      'menu_viewed',
      'dish_viewed',
      'dish_detail_opened',
      'dish_activity_checkpoint',
      'dish_compared',
      'dish_saved',
      'dish_unsaved',
      'shortlist_viewed',
    ]);
    for (const name of P0_EVENT_NAMES) expect(isAllowedEvent(name)).toBe(true);
  });

  it('rejects unknown, near-miss and not-yet-adopted names', () => {
    for (const name of [
      'search_performed',
      'toast_shown',
      'Dish_Saved',
      'dish_saved ',
      'dish_detail_closed',
      '',
    ]) {
      expect(isAllowedEvent(name)).toBe(false);
    }
  });
});

describe('ID helpers', () => {
  it('return fresh lowercase UUIDs that never repeat', () => {
    const ids = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      for (const id of [newExposureId(), newOpeningId(), newComparisonId()]) {
        expect(id).toMatch(UUID);
        ids.add(id);
      }
    }
    expect(ids.size).toBe(3000);
  });
});

describe('per-tab, per-visit identity', () => {
  it('starts a visit with new IDs and a sequence from 1', () => {
    const { identity } = tab(new FakeSession());
    const first = identity.next();
    const second = identity.next();
    expect(first.localSequence).toBe(1);
    expect(second.localSequence).toBe(2);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.producerId).toBe(first.producerId);
    expect(first.sessionId).not.toBe(first.producerId);
  });

  it('keeps the IDs across a reload in the same tab and continues the sequence', () => {
    const store = new FakeSession();
    const before = tab(store);
    const a = before.identity.next();
    before.identity.next();
    before.pagehide();
    const after = tab(store).identity.next();
    expect(after).toEqual({ sessionId: a.sessionId, producerId: a.producerId, localSequence: 3 });
  });

  it('gives a duplicated tab fresh IDs instead of the copied ones', () => {
    const store = new FakeSession();
    const original = tab(store);
    const a = original.identity.next();
    // The browser copies sessionStorage into the new tab while the original is still open.
    const copy = new FakeSession();
    for (const [key, value] of store.values) copy.values.set(key, value);
    const duplicate = tab(copy).identity.next();
    expect(duplicate.sessionId).not.toBe(a.sessionId);
    expect(duplicate.producerId).not.toBe(a.producerId);
    expect(duplicate.localSequence).toBe(1);
    // The original tab carries on unaffected.
    expect(original.identity.next()).toMatchObject({ producerId: a.producerId, localSequence: 2 });
  });

  it('keeps its IDs when restored from the back-forward cache', () => {
    const store = new FakeSession();
    const page = tab(store);
    const a = page.identity.next();
    page.pagehide();
    page.pageshow();
    expect(page.identity.next()).toMatchObject({ producerId: a.producerId, localSequence: 2 });
  });

  it('starts a new visit after 30 minutes without activity: new IDs and sequence together', () => {
    const clock = { t: 0 };
    const { identity } = tab(new FakeSession(), clock);
    const a = identity.next();
    clock.t = VISIT_TIMEOUT_MS - 1;
    expect(identity.next()).toMatchObject({ producerId: a.producerId, localSequence: 2 });
    clock.t += VISIT_TIMEOUT_MS;
    const b = identity.next();
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.producerId).not.toBe(a.producerId);
    expect(b.localSequence).toBe(1);
  });

  it('starts a new visit on reload after 30 minutes away', () => {
    const store = new FakeSession();
    const clock = { t: 0 };
    const before = tab(store, clock);
    const a = before.identity.next();
    before.pagehide();
    clock.t = VISIT_TIMEOUT_MS;
    const b = tab(store, clock).identity.next();
    expect(b.producerId).not.toBe(a.producerId);
    expect(b.localSequence).toBe(1);
  });

  it('keeps identity in memory when storage is blocked', () => {
    const store = new FakeSession();
    store.failWrites = true;
    const { identity } = tab(store);
    const a = identity.next();
    expect(identity.next()).toMatchObject({ producerId: a.producerId, localSequence: 2 });
    expect(tab(null).identity.next().localSequence).toBe(1);
  });

  it('never lets a reload reuse sequence numbers after a failed write', () => {
    const store = new FakeSession();
    const before = tab(store);
    const a = before.identity.next();
    store.failWrites = true;
    before.identity.next();
    before.pagehide();
    store.failWrites = false;
    // The stored state is stale, so the reload must not continue the same producer from it.
    const after = tab(store).identity.next();
    expect(after.producerId === a.producerId && after.localSequence <= 2).toBe(false);
  });

  it('starts fresh when the stored identity is damaged', () => {
    const store = new FakeSession();
    store.values.set(IDENTITY_KEY, '{not json');
    expect(tab(store).identity.next().localSequence).toBe(1);
  });
});

describe('envelope', () => {
  function context() {
    const { identity } = tab(new FakeSession(), { t: Date.UTC(2026, 9, 31, 12) });
    return { identity, now: () => Date.UTC(2026, 9, 31, 12), uuid: counter('eeee') };
  }
  const saved = {
    publication_revision_id: PUBLICATION,
    dish_id: DISH,
    dish_revision_id: REVISION,
    save_origin: 'direct',
    save_surface: 'menu_card',
    shortlist_size: 1,
  };

  it('builds an observation.v2 envelope and lifts publication_revision_id out of the payload', () => {
    const envelope = buildEnvelope('dish_saved', saved, context());
    expect(envelope).toEqual({
      schema_version: 'observation.v2',
      event_id: 'eeee0000-0000-4000-8000-000000000000',
      type: 'dish_saved',
      session_id: expect.any(String),
      producer_id: expect.any(String),
      local_sequence: 1,
      occurred_at: '2026-10-31T12:00:00.000Z',
      publication_revision_id: PUBLICATION,
      payload: {
        dish_id: DISH,
        dish_revision_id: REVISION,
        save_origin: 'direct',
        save_surface: 'menu_card',
        shortlist_size: 1,
      },
    });
    expect(typeof envelope?.schema_version).toBe('string');
    expect(envelope?.schema_version).not.toBe(2);
  });

  it('is frozen, so a retry always sends the same event_id and payload', () => {
    const envelope = buildEnvelope('dish_saved', saved, context());
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope?.payload)).toBe(true);
  });

  it('rejects unknown names and invalid events before using a sequence number', () => {
    const ctx = context();
    expect(buildEnvelope('toast_shown', saved, ctx)).toBeNull();
    expect(
      buildEnvelope('dish_saved', { ...saved, publication_revision_id: undefined }, ctx),
    ).toBeNull();
    expect(buildEnvelope('dish_saved', saved, { ...ctx, validate: () => false })).toBeNull();
    expect(buildEnvelope('dish_saved', saved, ctx)?.local_sequence).toBe(1);
  });

  it('never carries venue authority', () => {
    const envelope = buildEnvelope('dish_saved', saved, context());
    expect(JSON.stringify(envelope)).not.toMatch(/venue|restaurant|token/);
  });
});

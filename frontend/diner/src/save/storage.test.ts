import { describe, expect, it } from 'vitest';
import { FakeStorage } from './fake-storage';
import { addNewest, withoutDish } from './saved-list';
import { createSavedPersistence, savedKey } from './storage';

const VENUE_A = 'a6000000-0000-4000-8000-000000000001';
const VENUE_B = 'a6000000-0000-4000-8000-000000000002';

const stored = (storage: FakeStorage, venueId: string) =>
  JSON.parse(storage.values.get(savedKey(venueId)) ?? 'null');

describe('saved list order', () => {
  it('puts a newly saved dish first', () => {
    expect(addNewest(['x'], 'y')).toEqual(['y', 'x']);
  });

  it('leaves an already saved dish where it is', () => {
    const ids = ['y', 'x'];
    expect(addNewest(ids, 'x')).toBe(ids);
  });

  it('moves a dish to the top when it is unsaved and saved again', () => {
    expect(addNewest(withoutDish(['y', 'x'], 'x'), 'x')).toEqual(['x', 'y']);
  });

  it('treats removing a dish that is not saved as a no-op', () => {
    const ids = ['x'];
    expect(withoutDish(ids, 'z')).toBe(ids);
  });

  it('has no cap on the number of saved dishes', () => {
    let ids: readonly string[] = [];
    for (let n = 0; n < 60; n++) ids = addNewest(ids, `dish-${n}`);
    expect(ids).toHaveLength(60);
    expect(ids[0]).toBe('dish-59');
  });
});

describe('saved dish storage', () => {
  it('stores only dish ids, under one key per restaurant', () => {
    const storage = new FakeStorage();
    const persistence = createSavedPersistence({ venueId: VENUE_A, storage });
    expect(persistence.persist(['y', 'x'])).toBe(true);
    expect(savedKey(VENUE_A)).toBe(`peekaplate:saved:v1:${VENUE_A}`);
    expect(stored(storage, VENUE_A)).toEqual({ version: 1, dishIds: ['y', 'x'] });
  });

  it('keeps two restaurants apart in the same browser', () => {
    const storage = new FakeStorage();
    createSavedPersistence({ venueId: VENUE_A, storage }).persist(['x']);
    expect(createSavedPersistence({ venueId: VENUE_B, storage }).load()).toEqual([]);
    expect(createSavedPersistence({ venueId: VENUE_A, storage }).load()).toEqual(['x']);
  });

  it('reads saved dishes back in the same order after a reload', () => {
    const storage = new FakeStorage();
    createSavedPersistence({ venueId: VENUE_A, storage }).persist(['z', 'y', 'x']);
    const reloaded = createSavedPersistence({ venueId: VENUE_A, storage });
    expect(reloaded.mode()).toBe('persistent');
    expect(reloaded.load()).toEqual(['z', 'y', 'x']);
  });
});

describe('session-only fallback', () => {
  it('starts session-only when the startup test write fails', () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const persistence = createSavedPersistence({ venueId: VENUE_A, storage });
    expect(persistence.mode()).toBe('session-only');
    expect(persistence.persist(['x'])).toBe(false);
  });

  it('starts session-only when there is no storage at all', () => {
    const persistence = createSavedPersistence({ venueId: VENUE_A, storage: null });
    expect(persistence.mode()).toBe('session-only');
    expect(persistence.load()).toEqual([]);
    expect(persistence.persist(['x'])).toBe(false);
  });

  it('switches to session-only for the rest of the visit when a write fails', () => {
    const storage = new FakeStorage();
    const persistence = createSavedPersistence({ venueId: VENUE_A, storage });
    expect(persistence.persist(['x'])).toBe(true);

    storage.failWrites = true;
    expect(persistence.persist(['y', 'x'])).toBe(false);
    expect(persistence.mode()).toBe('session-only');
    expect(stored(storage, VENUE_A)).toEqual({ version: 1, dishIds: ['x'] });

    // Storage working again later must not backfill anything during this visit.
    storage.failWrites = false;
    const writesBefore = storage.writes;
    expect(persistence.persist(['z', 'y', 'x'])).toBe(false);
    expect(storage.writes).toBe(writesBefore);
  });

  it('still reads earlier saves when only writing is blocked', () => {
    const storage = new FakeStorage();
    createSavedPersistence({ venueId: VENUE_A, storage }).persist(['x']);
    storage.failWrites = true;
    const persistence = createSavedPersistence({ venueId: VENUE_A, storage });
    expect(persistence.mode()).toBe('session-only');
    expect(persistence.load()).toEqual(['x']);
  });

  it('starts empty when reading is blocked', () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    expect(createSavedPersistence({ venueId: VENUE_A, storage }).load()).toEqual([]);
  });
});

describe('re-reading the latest saves', () => {
  it('returns what another tab wrote', () => {
    const storage = new FakeStorage();
    const persistence = createSavedPersistence({ venueId: VENUE_A, storage });
    createSavedPersistence({ venueId: VENUE_A, storage }).persist(['y', 'x']);
    expect(persistence.reread()).toEqual(['y', 'x']);
  });

  it('reports a failed read as null, not as an empty list', () => {
    const storage = new FakeStorage();
    const persistence = createSavedPersistence({ venueId: VENUE_A, storage });
    persistence.persist(['x']);
    storage.failReads = true;
    expect(persistence.reread()).toBeNull();
  });
});

describe('damaged stored data', () => {
  const loadRaw = (raw: string) => {
    const storage = new FakeStorage();
    storage.values.set(savedKey(VENUE_A), raw);
    return createSavedPersistence({ venueId: VENUE_A, storage }).load();
  };

  it('starts empty when the stored value is not JSON', () => {
    expect(loadRaw('{not json')).toEqual([]);
  });

  it('starts empty for an unknown version or shape', () => {
    expect(loadRaw(JSON.stringify({ version: 2, dishIds: ['x'] }))).toEqual([]);
    expect(loadRaw(JSON.stringify(['x']))).toEqual([]);
    expect(loadRaw(JSON.stringify({ version: 1, dishIds: 'x' }))).toEqual([]);
  });

  it('drops entries that are not dish ids and removes duplicates', () => {
    expect(loadRaw(JSON.stringify({ version: 1, dishIds: ['y', 3, '', 'x', 'y', null] }))).toEqual([
      'y',
      'x',
    ]);
  });
});

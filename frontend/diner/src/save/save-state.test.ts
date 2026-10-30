import { describe, expect, it, vi } from 'vitest';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import type { Menu } from '../menu/types';
import { FakeStorage } from './fake-storage';
import { createSaveState } from './save-state';
import { savedKey } from './storage';

type Scenario = Parameters<typeof createFixtureMenuSource>[0];

async function loadMenus(scenario: Scenario, loads: number): Promise<Menu[]> {
  const source = createFixtureMenuSource(scenario);
  const menus: Menu[] = [];
  for (let n = 0; n < loads; n++) {
    const result = await source.load();
    if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
    menus.push(result.menu);
  }
  return menus;
}

async function loadMenu(scenario: Scenario = 'edge-cases'): Promise<Menu> {
  const [menu] = await loadMenus(scenario, 1);
  if (!menu) throw new Error('no menu');
  return menu;
}

// The same menu after an update that leaves one dish on the menu but incomplete.
function withIncomplete(menu: Menu, dishId: string): Menu {
  return {
    ...menu,
    categories: menu.categories.map((category) => ({
      ...category,
      dishes: category.dishes.map((dish) =>
        dish.dishId === dishId
          ? {
              kind: 'incomplete' as const,
              dishId: dish.dishId,
              dishRevisionId: dish.dishRevisionId,
              categoryId: dish.categoryId,
            }
          : dish,
      ),
    })),
  };
}

const stored = (storage: FakeStorage, venueId: string) =>
  JSON.parse(storage.values.get(savedKey(venueId)) ?? 'null');

async function readyState(storage = new FakeStorage()) {
  const menu = await loadMenu();
  const state = createSaveState({ venueId: menu.venueId, storage });
  state.reconcile(menu);
  return { menu, state, storage };
}

describe('saving and unsaving', () => {
  it('saves a dish and reports the committed change', async () => {
    const { state, storage, menu } = await readyState();
    expect(state.save(DISH.avocadoToast)).toEqual({
      changed: true,
      persisted: true,
      savedCount: 1,
    });
    expect(state.isSaved(DISH.avocadoToast)).toBe(true);
    expect(stored(storage, menu.venueId).dishIds).toEqual([DISH.avocadoToast]);
  });

  it('keeps the newest saved dish first', async () => {
    const { state } = await readyState();
    state.save(DISH.avocadoToast);
    state.save(DISH.harvestPowerBowl);
    expect(state.savedDishIds()).toEqual([DISH.harvestPowerBowl, DISH.avocadoToast]);
    expect(state.savedCount()).toBe(2);
  });

  it('treats saving an already saved dish as a no-op that writes nothing', async () => {
    const { state, storage } = await readyState();
    state.save(DISH.avocadoToast);
    state.save(DISH.harvestPowerBowl);
    const writes = storage.writes;
    expect(state.save(DISH.avocadoToast)).toEqual({
      changed: false,
      persisted: false,
      savedCount: 2,
    });
    expect(state.savedDishIds()).toEqual([DISH.harvestPowerBowl, DISH.avocadoToast]);
    expect(storage.writes).toBe(writes);
  });

  it('moves a dish to the top when it is unsaved and saved again', async () => {
    const { state } = await readyState();
    state.save(DISH.avocadoToast);
    state.save(DISH.harvestPowerBowl);
    expect(state.unsave(DISH.avocadoToast)).toEqual({
      changed: true,
      persisted: true,
      savedCount: 1,
    });
    state.save(DISH.avocadoToast);
    expect(state.savedDishIds()).toEqual([DISH.avocadoToast, DISH.harvestPowerBowl]);
  });

  it('treats unsaving a dish that is not saved as a no-op', async () => {
    const { state } = await readyState();
    expect(state.unsave(DISH.avocadoToast)).toEqual({
      changed: false,
      persisted: false,
      savedCount: 0,
    });
  });

  it('only saves dishes in the current menu', async () => {
    const { state } = await readyState();
    expect(state.save('a1000000-0000-4000-8000-999999999999').changed).toBe(false);
    expect(state.savedCount()).toBe(0);
  });

  it('saves nothing before a menu has loaded', () => {
    const state = createSaveState({ venueId: 'v', storage: new FakeStorage() });
    expect(state.save(DISH.avocadoToast).changed).toBe(false);
  });

  it('allows saving an incomplete dish, which Undo needs', async () => {
    const { state } = await readyState();
    expect(state.save(DISH.incomplete).changed).toBe(true);
  });
});

describe('notifying screens', () => {
  it('notifies after the write and the state update, before returning', async () => {
    const { state, storage, menu } = await readyState();
    const seen: unknown[] = [];
    state.subscribe(() => {
      seen.push({
        saved: state.isSaved(DISH.avocadoToast),
        stored: stored(storage, menu.venueId).dishIds,
      });
    });
    state.save(DISH.avocadoToast);
    expect(seen).toEqual([{ saved: true, stored: [DISH.avocadoToast] }]);
  });

  it('does not notify for a no-op', async () => {
    const { state } = await readyState();
    state.save(DISH.avocadoToast);
    const listener = vi.fn();
    state.subscribe(listener);
    state.save(DISH.avocadoToast);
    state.unsave(DISH.harvestPowerBowl);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    const { state } = await readyState();
    const listener = vi.fn();
    const stop = state.subscribe(listener);
    stop();
    state.save(DISH.avocadoToast);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps notifying other screens when one listener throws', async () => {
    const { state } = await readyState();
    const listener = vi.fn();
    state.subscribe(() => {
      throw new Error('broken screen');
    });
    state.subscribe(listener);
    expect(() => state.save(DISH.avocadoToast)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('restaurants and reloads', () => {
  it('keeps two restaurants apart in the same browser', async () => {
    const { state, storage, menu } = await readyState();
    state.save(DISH.avocadoToast);
    const other = { ...menu, venueId: 'a6000000-0000-4000-8000-000000000002' };
    const otherState = createSaveState({ venueId: other.venueId, storage });
    otherState.reconcile(other);
    expect(otherState.savedCount()).toBe(0);
  });

  it('reads saved dishes back after a reload without reporting them as changes', async () => {
    const storage = new FakeStorage();
    const { state, menu } = await readyState(storage);
    state.save(DISH.avocadoToast);
    state.save(DISH.harvestPowerBowl);

    const reloaded = createSaveState({ venueId: menu.venueId, storage });
    const listener = vi.fn();
    reloaded.subscribe(listener);
    expect(reloaded.reconcile(menu)).toEqual({ removed: [] });
    expect(reloaded.savedDishIds()).toEqual([DISH.harvestPowerBowl, DISH.avocadoToast]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a menu from another restaurant', async () => {
    const { state, menu } = await readyState();
    state.save(DISH.avocadoToast);
    const other = { ...menu, venueId: 'a6000000-0000-4000-8000-000000000002', categories: [] };
    expect(state.reconcile(other)).toEqual({ removed: [] });
    expect(state.isSaved(DISH.avocadoToast)).toBe(true);
  });
});

describe('reload re-check', () => {
  it('removes a withdrawn dish without reporting an unsave', async () => {
    const [first, second] = await loadMenus('withdrawal', 2);
    if (!first || !second) throw new Error('missing menus');
    const storage = new FakeStorage();
    const state = createSaveState({ venueId: first.venueId, storage });
    state.reconcile(first);
    state.save(DISH.salmonPokeBowl);
    state.save(DISH.harvestPowerBowl);

    const listener = vi.fn();
    state.subscribe(listener);
    expect(state.reconcile(second)).toEqual({ removed: [DISH.salmonPokeBowl] });
    expect(state.savedDishIds()).toEqual([DISH.harvestPowerBowl]);
    expect(stored(storage, first.venueId).dishIds).toEqual([DISH.harvestPowerBowl]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps a dish that is still on the menu but now incomplete', async () => {
    const { state, menu } = await readyState();
    state.save(DISH.harvestPowerBowl);
    expect(state.reconcile(withIncomplete(menu, DISH.harvestPowerBowl))).toEqual({ removed: [] });
    expect(state.isSaved(DISH.harvestPowerBowl)).toBe(true);
  });

  it('handles a withdrawn and an incomplete dish in the same reload', async () => {
    const [first, second] = await loadMenus('withdrawal', 2);
    if (!first || !second) throw new Error('missing menus');
    const state = createSaveState({ venueId: first.venueId, storage: new FakeStorage() });
    state.reconcile(first);
    state.save(DISH.salmonPokeBowl);
    state.save(DISH.harvestPowerBowl);
    const result = state.reconcile(withIncomplete(second, DISH.harvestPowerBowl));
    expect(result).toEqual({ removed: [DISH.salmonPokeBowl] });
    expect(state.savedDishIds()).toEqual([DISH.harvestPowerBowl]);
  });

  it('writes nothing when nothing was removed', async () => {
    const { state, storage, menu } = await readyState();
    state.save(DISH.avocadoToast);
    const writes = storage.writes;
    state.reconcile(menu);
    expect(storage.writes).toBe(writes);
  });

  it('still removes withdrawn dishes in memory when the write fails', async () => {
    const [first, second] = await loadMenus('withdrawal', 2);
    if (!first || !second) throw new Error('missing menus');
    const storage = new FakeStorage();
    const state = createSaveState({ venueId: first.venueId, storage });
    state.reconcile(first);
    state.save(DISH.salmonPokeBowl);
    storage.failWrites = true;
    expect(state.reconcile(second)).toEqual({ removed: [DISH.salmonPokeBowl] });
    expect(state.isSaved(DISH.salmonPokeBowl)).toBe(false);
    expect(state.mode()).toBe('session-only');
  });
});

describe('session-only mode', () => {
  it('works in memory when storage is blocked from the start', async () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const { state } = await readyState(storage);
    expect(state.mode()).toBe('session-only');
    expect(state.isSaveAvailable()).toBe(false);
    expect(state.save(DISH.avocadoToast)).toEqual({
      changed: true,
      persisted: false,
      savedCount: 1,
    });
    expect(state.isSaved(DISH.avocadoToast)).toBe(true);
  });

  it('switches to session-only and notifies when a write fails mid-visit', async () => {
    const { state, storage } = await readyState();
    state.save(DISH.avocadoToast);
    const listener = vi.fn(() => state.mode());
    state.subscribe(listener);
    storage.failWrites = true;
    expect(state.save(DISH.harvestPowerBowl)).toEqual({
      changed: true,
      persisted: false,
      savedCount: 2,
    });
    expect(listener).toHaveReturnedWith('session-only');
    expect(state.isSaveAvailable()).toBe(false);
  });

  it('reports save availability whether or not anything is saved', async () => {
    const { state } = await readyState();
    expect(state.isSaveAvailable()).toBe(true);
    state.save(DISH.avocadoToast);
    expect(state.isSaveAvailable()).toBe(true);
  });
});

describe('Undo at the state level', () => {
  it('restores an unsaved dish to the top', async () => {
    const { state } = await readyState();
    state.save(DISH.avocadoToast);
    state.save(DISH.harvestPowerBowl);
    state.unsave(DISH.avocadoToast);
    expect(state.save(DISH.avocadoToast).changed).toBe(true);
    expect(state.savedDishIds()[0]).toBe(DISH.avocadoToast);
  });

  it('makes a second Undo, or Undo after re-saving elsewhere, a no-op', async () => {
    const { state } = await readyState();
    state.save(DISH.avocadoToast);
    state.unsave(DISH.avocadoToast);
    state.save(DISH.avocadoToast);
    expect(state.save(DISH.avocadoToast).changed).toBe(false);
  });

  it('restores a dish that became incomplete before Undo', async () => {
    const { state, menu } = await readyState();
    state.save(DISH.harvestPowerBowl);
    state.unsave(DISH.harvestPowerBowl);
    state.reconcile(withIncomplete(menu, DISH.harvestPowerBowl));
    expect(state.save(DISH.harvestPowerBowl).changed).toBe(true);
  });
});

// Adam, 30 Oct: no live sync in P0, but each save or unsave re-reads storage, applies only its
// own change and writes it back, so a stale tab can never wipe saves made in another tab.
describe('two tabs of the same restaurant', () => {
  async function twoTabs() {
    const storage = new FakeStorage();
    const menu = await loadMenu();
    const tabA = createSaveState({ venueId: menu.venueId, storage });
    const tabB = createSaveState({ venueId: menu.venueId, storage });
    tabA.reconcile(menu);
    tabB.reconcile(menu);
    return { storage, menu, tabA, tabB };
  }

  it("a stale tab's save keeps the other tab's saves", async () => {
    const { storage, menu, tabA, tabB } = await twoTabs();
    tabB.save(DISH.avocadoToast);
    expect(tabA.save(DISH.harvestPowerBowl)).toEqual({
      changed: true,
      persisted: true,
      savedCount: 2,
    });
    expect(stored(storage, menu.venueId).dishIds).toEqual([
      DISH.harvestPowerBowl,
      DISH.avocadoToast,
    ]);
    expect(tabA.savedDishIds()).toEqual([DISH.harvestPowerBowl, DISH.avocadoToast]);
  });

  it("a stale tab's unsave removes only its own dish", async () => {
    const { storage, menu, tabA, tabB } = await twoTabs();
    tabA.save(DISH.avocadoToast);
    tabB.save(DISH.harvestPowerBowl);
    tabA.unsave(DISH.avocadoToast);
    expect(stored(storage, menu.venueId).dishIds).toEqual([DISH.harvestPowerBowl]);
  });

  it("reports no change for another tab's work, but refreshes the screens", async () => {
    const { tabA, tabB } = await twoTabs();
    tabB.save(DISH.avocadoToast);
    const listener = vi.fn();
    tabA.subscribe(listener);
    expect(tabA.save(DISH.avocadoToast)).toEqual({
      changed: false,
      persisted: false,
      savedCount: 1,
    });
    expect(tabA.isSaved(DISH.avocadoToast)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    tabB.unsave(DISH.avocadoToast);
    expect(tabA.unsave(DISH.avocadoToast).changed).toBe(false);
    expect(tabA.isSaved(DISH.avocadoToast)).toBe(false);
  });

  it('re-checks against the latest saves on reload', async () => {
    const [first, second] = await loadMenus('withdrawal', 2);
    if (!first || !second) throw new Error('missing menus');
    const storage = new FakeStorage();
    const tabA = createSaveState({ venueId: first.venueId, storage });
    const tabB = createSaveState({ venueId: first.venueId, storage });
    tabA.reconcile(first);
    tabB.reconcile(first);
    tabB.save(DISH.salmonPokeBowl);
    tabB.save(DISH.harvestPowerBowl);
    expect(tabA.reconcile(second)).toEqual({ removed: [DISH.salmonPokeBowl] });
    expect(stored(storage, first.venueId).dishIds).toEqual([DISH.harvestPowerBowl]);
  });

  it('keeps its own list when storage cannot be read for a moment', async () => {
    const { storage, tabA } = await twoTabs();
    tabA.save(DISH.avocadoToast);
    storage.failReads = true;
    tabA.save(DISH.harvestPowerBowl);
    expect(tabA.savedDishIds()).toEqual([DISH.harvestPowerBowl, DISH.avocadoToast]);
  });

  it('stays memory-only in session-only mode', async () => {
    const { storage, menu } = await readyState();
    storage.failWrites = true;
    const tab = createSaveState({ venueId: menu.venueId, storage });
    tab.reconcile(menu);
    storage.values.set(
      savedKey(menu.venueId),
      JSON.stringify({ version: 1, dishIds: [DISH.eggsBenedict] }),
    );
    tab.save(DISH.avocadoToast);
    expect(tab.savedDishIds()).toEqual([DISH.avocadoToast]);
  });
});

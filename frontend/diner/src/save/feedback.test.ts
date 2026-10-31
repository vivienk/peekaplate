import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import type { Dish, Menu } from '../menu/types';
import { dishSavedPayload, dishUnsavedPayload } from './events';
import { FakeStorage } from './fake-storage';
import { createSaveFeedback, REMOVED_TOAST_MS, RESTORED_TOAST_MS, type Toast } from './feedback';
import { createSaveState } from './save-state';

async function loadMenu(): Promise<Menu> {
  const result = await createFixtureMenuSource('edge-cases').load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

function findDish(menu: Menu, dishId: string): Dish {
  const dish = menu.categories.flatMap((c) => c.dishes).find((d) => d.dishId === dishId);
  if (!dish) throw new Error(`missing ${dishId}`);
  return dish;
}

async function setup(storage = new FakeStorage()) {
  const menu = await loadMenu();
  // Fake timers only after the fixture menu has loaded (its loader waits on a timer).
  vi.useFakeTimers();
  const saveState = createSaveState({ venueId: menu.venueId, storage });
  saveState.reconcile(menu);
  const toasts: (Toast | null)[] = [];
  const send = vi.fn();
  const feedback = createSaveFeedback(saveState, (toast) => toasts.push(toast));
  const target = (dishId: string, surface: 'menu_card' | 'dish_detail' = 'menu_card') => ({
    menu,
    dish: findDish(menu, dishId),
    surface,
    send,
  });
  const lastToast = () => toasts[toasts.length - 1] ?? null;
  return { menu, saveState, storage, toasts, send, feedback, target, lastToast };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('event payloads', () => {
  it('builds dish_saved with exactly the observation.v2 fields', async () => {
    const menu = await loadMenu();
    const dish = findDish(menu, DISH.avocadoToast);
    if (dish.kind !== 'complete') throw new Error('expected a complete dish');
    expect(dishSavedPayload(menu, dish, 'undo', 'saved_screen', 3)).toEqual({
      publication_revision_id: menu.publicationRevisionId,
      dish_id: dish.dishId,
      dish_revision_id: dish.dishRevisionId,
      save_origin: 'undo',
      save_surface: 'saved_screen',
      shortlist_size: 3,
    });
  });

  it('builds dish_unsaved with exactly the observation.v2 fields', async () => {
    const menu = await loadMenu();
    const dish = findDish(menu, DISH.avocadoToast);
    if (dish.kind !== 'complete') throw new Error('expected a complete dish');
    expect(dishUnsavedPayload(menu, dish, 'compare_view', 0)).toEqual({
      publication_revision_id: menu.publicationRevisionId,
      dish_id: dish.dishId,
      dish_revision_id: dish.dishRevisionId,
      unsave_surface: 'compare_view',
      shortlist_size: 0,
    });
  });
});

describe('saving and unsaving from a heart', () => {
  it('saves and sends one dish_saved with origin direct and the surface', async () => {
    const { feedback, target, send, menu, lastToast } = await setup();
    feedback.toggle(target(DISH.avocadoToast, 'dish_detail'));
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('dish_saved', {
      publication_revision_id: menu.publicationRevisionId,
      dish_id: DISH.avocadoToast,
      dish_revision_id: findDish(menu, DISH.avocadoToast).dishRevisionId,
      save_origin: 'direct',
      save_surface: 'dish_detail',
      shortlist_size: 1,
    });
    expect(lastToast()).toBeNull();
  });

  it('unsaves immediately, sends dish_unsaved and shows the removed toast with Undo', async () => {
    const { feedback, target, send, saveState, lastToast } = await setup();
    feedback.toggle(target(DISH.avocadoToast));
    send.mockClear();
    feedback.toggle(target(DISH.avocadoToast));
    expect(saveState.isSaved(DISH.avocadoToast)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe('dish_unsaved');
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      unsave_surface: 'menu_card',
      shortlist_size: 0,
    });
    expect(lastToast()).toMatchObject({ kind: 'removed', dishId: DISH.avocadoToast });
  });

  it('does not save an incomplete dish from a heart (only Undo may restore one)', async () => {
    const { feedback, target, saveState, send } = await setup();
    feedback.toggle(target(DISH.incomplete));
    expect(saveState.isSaved(DISH.incomplete)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('lets a saved incomplete placeholder be removed, with no event', async () => {
    const { feedback, target, saveState, send, lastToast } = await setup();
    saveState.save(DISH.incomplete);
    feedback.toggle(target(DISH.incomplete));
    expect(saveState.isSaved(DISH.incomplete)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ kind: 'removed' });
  });

  it('keeps working when sending an event throws', async () => {
    const { feedback, target, send, saveState } = await setup();
    send.mockImplementation(() => {
      throw new Error('tracking down');
    });
    expect(() => feedback.toggle(target(DISH.avocadoToast))).not.toThrow();
    expect(saveState.isSaved(DISH.avocadoToast)).toBe(true);
  });
});

describe('Undo and toasts', () => {
  async function removed() {
    const ctx = await setup();
    ctx.feedback.toggle(ctx.target(DISH.avocadoToast));
    ctx.feedback.toggle(ctx.target(DISH.avocadoToast));
    ctx.send.mockClear();
    const toast = ctx.lastToast();
    if (toast?.kind !== 'removed') throw new Error('expected a removed toast');
    return { ...ctx, undo: toast.undo };
  }

  it('save, unsave, Undo: one dish_saved with origin undo, saved at the top, restored toast', async () => {
    const { undo, send, saveState, lastToast } = await removed();
    undo();
    expect(saveState.savedDishIds()[0]).toBe(DISH.avocadoToast);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe('dish_saved');
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      save_origin: 'undo',
      save_surface: 'menu_card',
    });
    expect(lastToast()).toMatchObject({ kind: 'restored', dishId: DISH.avocadoToast });
  });

  it('removed toast goes away after 5 seconds with no further event, and Undo then does nothing', async () => {
    const { undo, send, saveState, lastToast } = await removed();
    vi.advanceTimersByTime(REMOVED_TOAST_MS - 1);
    expect(lastToast()).toMatchObject({ kind: 'removed' });
    vi.advanceTimersByTime(1);
    expect(lastToast()).toBeNull();
    undo();
    expect(saveState.isSaved(DISH.avocadoToast)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('restored toast goes away after 3 seconds', async () => {
    const { undo, lastToast } = await removed();
    undo();
    vi.advanceTimersByTime(RESTORED_TOAST_MS - 1);
    expect(lastToast()).toMatchObject({ kind: 'restored' });
    vi.advanceTimersByTime(1);
    expect(lastToast()).toBeNull();
  });

  it('a second Undo tap does nothing', async () => {
    const { undo, send } = await removed();
    undo();
    undo();
    expect(send).toHaveBeenCalledOnce();
  });

  it('Undo after the dish was saved again elsewhere does nothing and fires no event', async () => {
    const { undo, send, saveState, lastToast } = await removed();
    saveState.save(DISH.avocadoToast);
    undo();
    expect(send).not.toHaveBeenCalled();
    expect(lastToast()).toBeNull();
  });

  it('only the latest removal can be undone, and a new removal replaces the toast', async () => {
    const { feedback, target, undo, lastToast, saveState } = await removed();
    feedback.toggle(target(DISH.harvestPowerBowl));
    feedback.toggle(target(DISH.harvestPowerBowl));
    expect(lastToast()).toMatchObject({ kind: 'removed', dishId: DISH.harvestPowerBowl });
    undo();
    expect(saveState.isSaved(DISH.avocadoToast)).toBe(false);
  });

  it('restores a dish that became incomplete before Undo, without an event', async () => {
    const { feedback, target, saveState, send, menu, lastToast } = await setup();
    feedback.toggle(target(DISH.harvestPowerBowl));
    feedback.toggle(target(DISH.harvestPowerBowl));
    const toast = lastToast();
    if (toast?.kind !== 'removed') throw new Error('expected a removed toast');
    const incompleteMenu: Menu = {
      ...menu,
      categories: menu.categories.map((c) => ({
        ...c,
        dishes: c.dishes.map((d) =>
          d.dishId === DISH.harvestPowerBowl
            ? {
                kind: 'incomplete' as const,
                dishId: d.dishId,
                dishRevisionId: d.dishRevisionId,
                categoryId: d.categoryId,
              }
            : d,
        ),
      })),
    };
    saveState.reconcile(incompleteMenu);
    // The screens re-render with the updated menu, which hands it to the feedback.
    feedback.useMenu(incompleteMenu);
    send.mockClear();
    toast.undo();
    expect(saveState.isSaved(DISH.harvestPowerBowl)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('session-only mode', () => {
  it('saves, unsaves and undoes in memory with toasts but fires no Save events', async () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const { feedback, target, send, saveState, lastToast } = await setup(storage);
    feedback.toggle(target(DISH.avocadoToast));
    feedback.toggle(target(DISH.avocadoToast));
    const toast = lastToast();
    if (toast?.kind !== 'removed') throw new Error('expected a removed toast');
    toast.undo();
    expect(saveState.isSaved(DISH.avocadoToast)).toBe(true);
    expect(lastToast()).toMatchObject({ kind: 'restored' });
    expect(send).not.toHaveBeenCalled();
  });
});

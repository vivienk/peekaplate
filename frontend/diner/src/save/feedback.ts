// What happens when a diner taps a heart (S3-DIN-02.2): save or unsave through the shared Save
// state, the Save events, latest-removal-only Undo and the removed/restored toasts. No DOM here,
// so every rule is unit-tested; mount.ts draws the result.
import type { Dish, Menu } from '../menu/types';
import { dishSavedPayload, dishUnsavedPayload, type SaveSurface, type SendEvent } from './events';
import type { SaveChange, SaveState } from './save-state';

export const REMOVED_TOAST_MS = 5000;
export const RESTORED_TOAST_MS = 3000;

export type Toast =
  | { kind: 'removed'; dishId: string; undo: () => void }
  | { kind: 'restored'; dishId: string };

export type HeartTarget = { menu: Menu; dish: Dish; surface: SaveSurface; send: SendEvent };

export function createSaveFeedback(saveState: SaveState, render: (toast: Toast | null) => void) {
  // Only the most recent removal can be undone; it ends with its toast or the next removal.
  let lastRemoval: HeartTarget | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The newest menu a screen has given us. A menu update can change a dish while its removed
  // toast is still showing, so Undo looks the dish up here rather than trusting the old copy.
  let latestMenu: Menu | null = null;

  function current(target: HeartTarget): HeartTarget {
    const menu = latestMenu ?? target.menu;
    const dish = menu.categories
      .flatMap((category) => category.dishes)
      .find((d) => d.dishId === target.dish.dishId);
    return dish ? { ...target, menu, dish } : target;
  }

  // One toast at a time: a new one replaces the current one. Only its own timer hides it, so
  // tapping elsewhere never dismisses it. Showing, hiding or expiring a toast sends no event.
  function show(toast: Toast | null, ms = 0) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    render(toast);
    if (toast === null) return;
    timer = setTimeout(() => {
      timer = null;
      if (toast.kind === 'removed') lastRemoval = null;
      render(null);
    }, ms);
  }

  // Events only for a committed write of a complete dish: nothing for no-ops, session-only mode,
  // failed writes or placeholders. A tracking failure never breaks Save.
  function emit(
    target: HeartTarget,
    change: SaveChange,
    build: (dish: Dish & { kind: 'complete' }) => [string, Record<string, unknown>],
  ) {
    if (!change.changed || !change.persisted || target.dish.kind !== 'complete') return;
    const [name, payload] = build(target.dish);
    try {
      target.send(name, payload);
    } catch {}
  }

  function undo(target: HeartTarget) {
    if (lastRemoval !== target) return;
    lastRemoval = null;
    const latest = current(target);
    const change = saveState.save(latest.dish.dishId);
    if (!change.changed) {
      // Already saved again elsewhere: nothing to restore and no event.
      show(null);
      return;
    }
    // A dish that has since become incomplete is restored as a placeholder, with no event.
    emit(latest, change, (dish) => [
      'dish_saved',
      dishSavedPayload(latest.menu, dish, 'undo', latest.surface, change.savedCount),
    ]);
    show({ kind: 'restored', dishId: target.dish.dishId }, RESTORED_TOAST_MS);
  }

  return {
    // Screens call this (through mount.ts) whenever they render with a new menu.
    useMenu(menu: Menu) {
      latestMenu = menu;
    },

    toggle(target: HeartTarget) {
      latestMenu = target.menu;
      const { dish } = target;
      if (saveState.isSaved(dish.dishId)) {
        const change = saveState.unsave(dish.dishId);
        if (!change.changed) return;
        // dish_unsaved fires now, when the dish leaves Saved, not when the toast expires.
        emit(target, change, (complete) => [
          'dish_unsaved',
          dishUnsavedPayload(target.menu, complete, target.surface, change.savedCount),
        ]);
        lastRemoval = target;
        show({ kind: 'removed', dishId: dish.dishId, undo: () => undo(target) }, REMOVED_TOAST_MS);
        return;
      }
      // An incomplete placeholder has no Save control; only Undo may restore one.
      if (dish.kind !== 'complete') return;
      const change = saveState.save(dish.dishId);
      emit(target, change, (complete) => [
        'dish_saved',
        dishSavedPayload(target.menu, complete, 'direct', target.surface, change.savedCount),
      ]);
    },
  };
}

export type SaveFeedback = ReturnType<typeof createSaveFeedback>;

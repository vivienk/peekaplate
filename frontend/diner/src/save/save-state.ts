// Shared Save state for one restaurant (S3-DIN-02.1). The one place that knows which dishes are
// saved and whether saving persists; the hearts, the header badge, the Compare picker and the Saved
// screen all read it. Interface agreed in the S3-DIN-02 ticket thread.
import type { Menu } from '../menu/types';
import { addNewest, withoutDish } from './saved-list';
import { createSavedPersistence, type SaveMode, type SaveStorage } from './storage';

export type SaveChange = {
  // False for a no-op: already saved or unsaved, a repeated Undo, or a dish not in the menu.
  changed: boolean;
  // True only when the storage write committed. Save events fire only when changed && persisted.
  persisted: boolean;
  // Saved count after the change, for shortlist_size.
  savedCount: number;
};

export type SaveState = {
  isSaved(dishId: string): boolean;
  savedDishIds(): readonly string[];
  savedCount(): number;
  isSaveAvailable(): boolean;
  mode(): SaveMode;
  save(dishId: string): SaveChange;
  unsave(dishId: string): SaveChange;
  reconcile(menu: Menu): { removed: string[] };
  subscribe(listener: () => void): () => void;
};

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function menuDishIds(menu: Menu): Set<string> {
  return new Set(menu.categories.flatMap((category) => category.dishes.map((d) => d.dishId)));
}

export function createSaveState({
  venueId,
  storage,
}: {
  venueId: string;
  storage?: SaveStorage | null;
}): SaveState {
  const persistence = createSavedPersistence(
    storage === undefined ? { venueId } : { venueId, storage },
  );
  let dishIds: readonly string[] = persistence.load();
  // Unknown until the first successful menu load; nothing can be saved before then.
  let inMenu: Set<string> | null = null;
  const listeners = new Set<() => void>();

  // One broken screen must not stop the others from updating.
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  }

  // Another tab may have changed storage since this one last read it (Adam, 30 Oct: no live sync
  // in P0). In persistent mode every change starts from the latest stored list, so a stale tab
  // never writes back an old one. Session-only mode cannot write, so it stays memory-only, and a
  // failed read keeps this tab's list. Returns true when the list was refreshed.
  function refresh(): boolean {
    if (persistence.mode() !== 'persistent') return false;
    const latest = persistence.reread();
    if (latest === null || sameIds(latest, dishIds)) return false;
    dishIds = latest;
    return true;
  }

  // Applies this tab's own change to the latest list: write, then update the state, then notify,
  // then report the result. Another tab's work is never reported as this tab's change, so it can
  // never fire an event; a refresh alone only updates the screens.
  function change(update: (ids: readonly string[]) => readonly string[]): SaveChange {
    const refreshed = refresh();
    const next = update(dishIds);
    if (next === dishIds) {
      if (refreshed) notify();
      return { changed: false, persisted: false, savedCount: dishIds.length };
    }
    const persisted = persistence.persist(next);
    dishIds = next;
    notify();
    return { changed: true, persisted, savedCount: next.length };
  }

  return {
    isSaved: (dishId) => dishIds.includes(dishId),
    savedDishIds: () => dishIds,
    savedCount: () => dishIds.length,
    isSaveAvailable: () => persistence.mode() === 'persistent',
    mode: () => persistence.mode(),

    // Complete or incomplete dishes in the current menu, so Undo can restore an incomplete one.
    save(dishId) {
      if (!inMenu?.has(dishId)) {
        return { changed: false, persisted: false, savedCount: dishIds.length };
      }
      return change((ids) => addNewest(ids, dishId));
    },

    unsave: (dishId) => change((ids) => withoutDish(ids, dishId)),

    // Call only after a successful menu load: a failed load must never wipe saves. Withdrawn
    // dishes are removed (not a diner action, so no event); incomplete ones stay as placeholders.
    reconcile(menu) {
      if (menu.venueId !== venueId) return { removed: [] };
      const current = menuDishIds(menu);
      inMenu = current;
      let removed: string[] = [];
      change((ids) => {
        removed = ids.filter((id) => !current.has(id));
        return removed.length > 0 ? ids.filter((id) => current.has(id)) : ids;
      });
      return { removed };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// What the Saved screen shows (S3-DIN-02.5), without DOM so it can be unit-tested.
import type { CompleteDish, Dish, IncompleteDish, Menu } from '../menu/types';
import type { SaveState } from './save-state';

export type SavedItem =
  | { kind: 'complete'; dish: CompleteDish }
  | { kind: 'incomplete'; dish: IncompleteDish };

// Saved dishes newest first, with their current details looked up in the loaded menu by dish ID.
// A dish missing from the menu is skipped (reconcile removes withdrawn dishes); an incomplete one
// becomes the placeholder.
export function savedItems(saveState: SaveState, menu: Menu): SavedItem[] {
  const dishes = new Map<string, Dish>(
    menu.categories.flatMap((category) => category.dishes.map((dish) => [dish.dishId, dish])),
  );
  return saveState.savedDishIds().flatMap((dishId): SavedItem[] => {
    const dish = dishes.get(dishId);
    if (!dish) return [];
    return dish.kind === 'complete' ? [{ kind: 'complete', dish }] : [{ kind: 'incomplete', dish }];
  });
}

// The tracking layer lifts publication_revision_id into the envelope (TRK-01 signature).
export function shortlistViewedPayload(menu: Menu, shortlistSize: number) {
  return { publication_revision_id: menu.publicationRevisionId, shortlist_size: shortlistSize };
}

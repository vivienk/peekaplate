// Save events for S3-DIN-02.2, shaped to the observation.v2 dish_saved and dish_unsaved payloads.
// publication_revision_id travels in the payload; the TRK-01 tracking layer lifts it into the
// envelope (agreed with Jeffin), so callers keep track(eventName, payload).
import type { CompleteDish, Menu } from '../menu/types';

// The observation.v2 save_surface / unsave_surface values. Any other value fails at compile time.
export const SAVE_SURFACES = ['menu_card', 'dish_detail', 'compare_view', 'saved_screen'] as const;
export type SaveSurface = (typeof SAVE_SURFACES)[number];

// Same shape as track(); the tracking layer is injected until S3-DIN-01.5 (#65) is on this branch.
export type SendEvent = (eventName: string, payload: Record<string, unknown>) => void;

export function dishSavedPayload(
  menu: Menu,
  dish: CompleteDish,
  origin: 'direct' | 'undo',
  surface: SaveSurface,
  shortlistSize: number,
) {
  return {
    publication_revision_id: menu.publicationRevisionId,
    dish_id: dish.dishId,
    dish_revision_id: dish.dishRevisionId,
    save_origin: origin,
    save_surface: surface,
    shortlist_size: shortlistSize,
  };
}

export function dishUnsavedPayload(
  menu: Menu,
  dish: CompleteDish,
  surface: SaveSurface,
  shortlistSize: number,
) {
  return {
    publication_revision_id: menu.publicationRevisionId,
    dish_id: dish.dishId,
    dish_revision_id: dish.dishRevisionId,
    unsave_surface: surface,
    shortlist_size: shortlistSize,
  };
}

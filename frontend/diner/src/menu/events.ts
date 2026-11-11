// DIN-01 UI triggers for menu_viewed and dish_detail_opened (Taxonomy v0.2, matrix v0.1g). Screens
// call these at the moment the content is readable; the shared tracking layer adds the envelope.
import { newOpeningId, track } from '../tracking';
import type { Dish, Menu } from './types';

export const ENTRY_SOURCES = ['qr', 'direct_link', 'unknown'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export const DETAIL_SOURCES = ['menu_card', 'compare_view', 'direct', 'saved_screen'] as const;
export type DetailSource = (typeof DETAIL_SOURCES)[number];

export const NAV_RELATIONS = ['none', 'from_compare', 'back_navigation'] as const;
export type NavRelation = (typeof NAV_RELATIONS)[number];

type Send = typeof track;

// Call once the menu is readable on screen, never for loading, empty, error or offline states.
// Fires once per publication revision per page, so re-renders and retries do not count again.
export function createMenuViewedTrigger(send: Send = track) {
  const seen = new Set<string>();
  return (menu: Menu, entrySource: EntrySource): void => {
    if (seen.has(menu.publicationRevisionId)) return;
    seen.add(menu.publicationRevisionId);
    try {
      send('menu_viewed', {
        publication_revision_id: menu.publicationRevisionId,
        entry_source: entrySource,
      });
    } catch {
      // Tracking must not break the menu.
    }
  };
}

export type DetailOpening = {
  source: DetailSource;
  fromExposureId?: string;
  navRelation?: NavRelation;
  // Read from DIN-02's shared Save state: saveState?.isSaveAvailable() ?? false.
  saveAvailable: boolean;
};

// Call when the readable dish detail appears, not on tap. Returns the new opening_id for the
// screen to keep across re-renders, or null for an incomplete dish, which fires no events.
export function trackDishDetailOpened(
  menu: Menu,
  dish: Dish,
  opening: DetailOpening,
  send: Send = track,
  newId: () => string = newOpeningId,
): string | null {
  if (dish.kind !== 'complete') return null;
  const openingId = newId();
  try {
    send('dish_detail_opened', {
      publication_revision_id: menu.publicationRevisionId,
      dish_id: dish.dishId,
      dish_revision_id: dish.dishRevisionId,
      opening_id: openingId,
      source: opening.source,
      ...(opening.fromExposureId === undefined ? {} : { from_exposure_id: opening.fromExposureId }),
      ...(opening.navRelation === undefined ? {} : { nav_relation: opening.navRelation }),
      save_available: opening.saveAvailable,
    });
  } catch {
    // Tracking must not break the detail screen.
  }
  return openingId;
}

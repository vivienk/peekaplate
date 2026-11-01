// Compare result and Replace (S3-DIN-02.4): the two dishes shown side by side and the
// dish_compared payload for each valid comparison actually displayed. The screen sends the payload
// through track(); picker open, cancel and failed comparisons produce nothing.
import { completeDishes } from '../menu/adapter';
import type { CompleteDish, Menu } from '../menu/types';
import { isSelectable, type PickerExclusions } from './picker';

export type CompareSide = 'first' | 'other';

export type Comparison = {
  comparisonId: string;
  // The dish Compare started from ("Keeping") is first; the picked dish is other.
  firstDishId: string;
  otherDishId: string;
};

export type CompareAction = 'start' | 'replace';

// Field names follow matrix v0.1h §3.1 for dish_compared. publication_revision_id is the menu's
// publication; per the TRK-01 rules the tracking layer lifts it into the event envelope.
export type DishComparedPayload = {
  publication_revision_id: string;
  comparison_id: string;
  compare_action: CompareAction;
  dish_id: string;
  dish_revision_id: string;
  other_dish_id: string;
  other_dish_revision_id: string;
  save_available: boolean;
};

// Generates comparison_id. The TRK-01 helper (newComparisonId) is passed in once it exists.
export type NewComparisonId = () => string;

function findComplete(menu: Menu, dishId: string): CompleteDish | undefined {
  return completeDishes(menu).find((d) => d.dishId === dishId);
}

// Starts a comparison when both dishes are complete and different; otherwise null.
export function startComparison(
  menu: Menu,
  keptDishId: string,
  pickedDishId: string,
  newId: NewComparisonId,
): Comparison | null {
  if (!findComplete(menu, keptDishId) || !isSelectable(menu, [keptDishId], pickedDishId)) {
    return null;
  }
  return { comparisonId: newId(), firstDishId: keptDishId, otherDishId: pickedDishId };
}

// The picker excludes both shown dishes when replacing one side.
export function replaceExclusions(comparison: Comparison): PickerExclusions {
  return [comparison.firstDishId, comparison.otherDishId];
}

// Replacing changes the pair without starting a new comparison, so the ID is kept (TRK-01 plan;
// Zhiliang to confirm). An invalid replacement leaves the comparison unchanged.
export function replaceSide(
  menu: Menu,
  comparison: Comparison,
  side: CompareSide,
  replacementDishId: string,
): Comparison {
  if (!isSelectable(menu, replaceExclusions(comparison), replacementDishId)) return comparison;
  return side === 'first'
    ? { ...comparison, firstDishId: replacementDishId }
    : { ...comparison, otherDishId: replacementDishId };
}

// The dish_compared payload for a comparison that is displayed, or null if either dish is no
// longer complete on the menu (a failed comparison is not a comparison).
export function dishComparedPayload(
  menu: Menu,
  comparison: Comparison,
  action: CompareAction,
  saveAvailable: boolean,
): DishComparedPayload | null {
  const first = findComplete(menu, comparison.firstDishId);
  const other = findComplete(menu, comparison.otherDishId);
  if (!first || !other || first.dishId === other.dishId) return null;
  return {
    publication_revision_id: menu.publicationRevisionId,
    comparison_id: comparison.comparisonId,
    compare_action: action,
    dish_id: first.dishId,
    dish_revision_id: first.dishRevisionId,
    other_dish_id: other.dishId,
    other_dish_revision_id: other.dishRevisionId,
    save_available: saveAvailable,
  };
}

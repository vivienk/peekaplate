import { completeDishes } from '../menu/adapter';
import type { CompleteDish, Menu } from '../menu/types';
import { isSelectable, type PickerExclusions } from './picker';

export type CompareSide = 'first' | 'other' | 'third';
export const MAX_COMPARE_CHOICES = 2;

export type Comparison = {
  comparisonId: string;
  // The dish Compare started from ("Keeping") is first; the picked dish is other.
  firstDishId: string;
  otherDishId: string;
  thirdDishId?: string;
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

// The kept dish and each pick must be distinct, complete dishes from the displayed menu.
export function startComparison(
  menu: Menu,
  keptDishId: string,
  pickedDishIds: readonly string[],
  newId: NewComparisonId,
): Comparison | null {
  const [otherDishId, thirdDishId] = pickedDishIds;
  const ids = [keptDishId, ...pickedDishIds];
  if (
    !otherDishId ||
    pickedDishIds.length > MAX_COMPARE_CHOICES ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !findComplete(menu, id))
  ) {
    return null;
  }
  return {
    comparisonId: newId(),
    firstDishId: keptDishId,
    otherDishId,
    ...(thirdDishId ? { thirdDishId } : {}),
  };
}

const sides: readonly CompareSide[] = ['first', 'other', 'third'];

export function comparisonDishes(menu: Menu, comparison: Comparison) {
  const shown: { side: CompareSide; dish: CompleteDish }[] = [];
  for (const side of sides) {
    const id = comparison[`${side}DishId`];
    if (side === 'third' && id === undefined) continue;
    const dish = id === undefined ? undefined : findComplete(menu, id);
    if (!dish || shown.some((entry) => entry.dish.dishId === id)) return [];
    shown.push({ side, dish });
  }
  return shown;
}

// The picker excludes every shown dish when replacing a side.
export function replaceExclusions({
  firstDishId,
  otherDishId,
  thirdDishId,
}: Comparison): PickerExclusions {
  return thirdDishId ? [firstDishId, otherDishId, thirdDishId] : [firstDishId, otherDishId];
}

// Replacing changes the pair without starting a new comparison, so the ID is kept (TRK-01 plan;
// Zhiliang to confirm). An invalid replacement leaves the comparison unchanged.
export function replaceSide(
  menu: Menu,
  comparison: Comparison,
  side: CompareSide,
  replacementDishId: string,
): Comparison {
  const slot = `${side}DishId` as const;
  if (!comparison[slot] || !isSelectable(menu, replaceExclusions(comparison), replacementDishId))
    return comparison;
  return { ...comparison, [slot]: replacementDishId };
}

// The existing observation contract records pairs. A result emits its new anchor/candidate
// pairs under one comparison ID. Counts of completed starts use distinct IDs, not row count.
export function dishComparedPayloads(
  menu: Menu,
  comparison: Comparison,
  action: CompareAction,
  saveAvailable: boolean,
  replacedSide?: CompareSide,
): DishComparedPayload[] {
  const [anchor, ...candidates] = comparisonDishes(menu, comparison);
  if (!anchor) return [];
  return candidates
    .filter(({ side }) => action === 'start' || replacedSide === 'first' || replacedSide === side)
    .map(({ dish: other }) => ({
      publication_revision_id: menu.publicationRevisionId,
      comparison_id: comparison.comparisonId,
      compare_action: action,
      dish_id: anchor.dish.dishId,
      dish_revision_id: anchor.dish.dishRevisionId,
      other_dish_id: other.dishId,
      other_dish_revision_id: other.dishRevisionId,
      save_available: saveAvailable,
    }));
}

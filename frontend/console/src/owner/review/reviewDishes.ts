// S5-FE-10 / S10 "Menu Review and Publish" (Figma frames S10_Review and S10_Ready to publish,
// developer handoff node 2793:15371). Pure rules for the dish table: statuses, display text,
// remove/undo and when Publish Menu is available. No I/O: the owner draft API supplies the dishes.
//
// ReviewDish mirrors OwnerDishFields from @peekaplate/contracts (packages/contracts/src/owner-menu.ts)
// plus the dish id, so the real draft data can be passed in without conversion once the API is wired.
// Unknown or only-proposed facts are never shown as recorded.

export type FactStatus = 'unknown' | 'proposed' | 'confirmed';

export interface DishFacts {
  status: FactStatus;
  items: readonly string[];
}

export interface ReviewDish {
  id: string;
  name: string | null;
  category: string | null;
  /** Decimal string as in OwnerDishFields.priceAmount ("14", "14.50"), or null when missing. */
  priceAmount: string | null;
  ingredients: DishFacts;
  allergens: DishFacts;
}

/** What the table shows in the Category and Price cells when the value is missing (Figma). */
export const NOT_FOUND = 'Not found';

export type DishStatusTone = 'success' | 'warning' | 'error';

export interface DishStatus {
  ready: boolean;
  label: string;
  tone: DishStatusTone;
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

function priceMissing(dish: ReviewDish): boolean {
  return isBlank(dish.priceAmount) || Number.isNaN(Number(dish.priceAmount));
}

/**
 * Status pill of one row. Figma shows Ready, Price Missing and Category Missing. The combined
 * label for a dish missing both is not in the design yet (to confirm with Rania).
 */
export function dishStatus(dish: ReviewDish): DishStatus {
  const noPrice = priceMissing(dish);
  const noCategory = isBlank(dish.category);
  if (noPrice && noCategory) {
    return { ready: false, label: 'Price and Category Missing', tone: 'error' };
  }
  if (noPrice) return { ready: false, label: 'Price Missing', tone: 'error' };
  if (noCategory) return { ready: false, label: 'Category Missing', tone: 'warning' };
  return { ready: true, label: 'Ready', tone: 'success' };
}

export function formatPrice(priceAmount: string | null): string {
  if (isBlank(priceAmount) || Number.isNaN(Number(priceAmount))) return NOT_FOUND;
  return `$${Number(priceAmount).toFixed(2)}`;
}

export function categoryLabel(dish: ReviewDish): string {
  return isBlank(dish.category) ? NOT_FOUND : (dish.category ?? NOT_FOUND);
}

/**
 * Second line under the dish name: "6 ingredients" or "5 ingredients · no allergen recorded".
 * Allergens count as recorded only when the owner confirmed them: unknown or merely proposed
 * allergens are never presented as safe or recorded.
 */
export function dishMeta(dish: ReviewDish): string {
  const count = dish.ingredients.items.length;
  const ingredients =
    count === 0 ? 'No ingredients recorded' : `${count} ingredient${count === 1 ? '' : 's'}`;
  const allergensRecorded = dish.allergens.status === 'confirmed';
  return allergensRecorded ? ingredients : `${ingredients} · no allergen recorded`;
}

/** Publish Menu is available only when at least one dish remains and every dish is Ready. */
export function isMenuReady(dishes: readonly ReviewDish[]): boolean {
  return dishes.length > 0 && dishes.every((dish) => dishStatus(dish).ready);
}

export type ReviewNotice = 'removed' | 'restored' | null;

export interface ReviewState {
  dishes: readonly ReviewDish[];
  /** The last removed dish and its position, so Undo restores it unchanged. */
  removed: { dish: ReviewDish; index: number } | null;
  /** "removed" shows Undo; "restored" shows no Undo; null shows no notice. */
  notice: ReviewNotice;
}

export function initialReview(dishes: readonly ReviewDish[]): ReviewState {
  return { dishes, removed: null, notice: null };
}

export function removeDish(state: ReviewState, id: string): ReviewState {
  const index = state.dishes.findIndex((dish) => dish.id === id);
  const dish = state.dishes[index];
  if (!dish) return state;
  return {
    dishes: state.dishes.filter((item) => item.id !== id),
    removed: { dish, index },
    notice: 'removed',
  };
}

export function undoRemove(state: ReviewState): ReviewState {
  if (!state.removed) return state;
  const dishes = [...state.dishes];
  dishes.splice(Math.min(state.removed.index, dishes.length), 0, state.removed.dish);
  return { dishes, removed: null, notice: 'restored' };
}

/** Replaces a dish saved from the S09 form. Any pending Undo or notice is cleared. */
export function saveEdit(state: ReviewState, edited: ReviewDish): ReviewState {
  if (!state.dishes.some((dish) => dish.id === edited.id)) return state;
  return {
    dishes: state.dishes.map((dish) => (dish.id === edited.id ? edited : dish)),
    removed: null,
    notice: null,
  };
}

/** Adds a dish saved from an empty S09 form. Any pending Undo or notice is cleared. */
export function addDish(state: ReviewState, added: ReviewDish): ReviewState {
  if (state.dishes.some((dish) => dish.id === added.id)) return state;
  return { dishes: [...state.dishes, added], removed: null, notice: null };
}

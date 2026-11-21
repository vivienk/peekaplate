// S5-FE-10 / S10 "Menu Review" (Figma frames S10_Review and S10_Ready to publish, developer handoff
// node 2793:15371). Pure rules for the dish table: statuses, display text, remove/undo and when
// the owner can complete verification. No I/O: the owner draft API supplies the dishes.
//
// ReviewDish mirrors OwnerDishFields from @peekaplate/contracts (packages/contracts/src/owner-menu.ts)
// plus the dish id, so the real draft data can be passed in without conversion once the API is wired.
// Unknown or only-proposed facts are never shown as recorded.

import { OwnerDishFieldsSchema } from '@peekaplate/contracts/owner-menu';

export type FactStatus = 'unknown' | 'proposed' | 'confirmed';

export interface DishFacts {
  status: FactStatus;
  items: readonly string[];
}

export interface ReviewDish {
  id: string;
  name: string | null;
  category: string | null;
  description: string | null;
  /** Decimal string as in OwnerDishFields.priceAmount ("14", "14.50"), or null when missing. */
  priceAmount: string | null;
  ingredients: DishFacts;
  allergens: DishFacts;
  photoId: string | null;
  /**
   * Descriptive serving size (S09 requires it; S10 shows "Serving Size Missing"):
   * undefined means the source does not provide it, so it is not checked; null or blank is missing.
   */
  servingSize?: string | null;
  /** Explicit number of people served; unknown never follows from the descriptive serving label. */
  servingCount?: number | null;
  /** Currency of priceAmount (three letters), when the source provides it. */
  priceCurrency?: string | null;
  /**
   * True once the owner has reviewed the dish in S09 (checked "I have reviewed the AI-drafted text and
   * ingredients" and saved). false: an extracted dish nobody has reviewed yet, so it is "Pending
   * Review" even when nothing is missing. undefined counts as reviewed (dishes the owner typed in).
   */
  reviewed?: boolean;
}

/** What the table shows in the Category and Price cells when the value is missing (Figma). */
export const NOT_FOUND = 'Not found';

/** The same minimum lengths the Add/Edit dish form (S09) enforces before it lets a dish through. */
export const MIN_NAME_LENGTH = 2;
export const MIN_DESCRIPTION_LENGTH = 20;

export type MissingField =
  | 'name'
  | 'category'
  | 'price'
  | 'servingSize'
  | 'description'
  | 'ingredients'
  | 'allergens'
  | 'photo';

export type DishStatusTone = 'success' | 'warning' | 'error' | 'information';

export interface DishStatus {
  ready: boolean;
  label: string;
  tone: DishStatusTone;
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

function priceValid(priceAmount: string | null): boolean {
  return (
    priceAmount !== null && OwnerDishFieldsSchema.shape.priceAmount.safeParse(priceAmount).success
  );
}

/**
 * The mandatory details (red * in S09): name, category, price, serving size (when the source provides
 * it), at least one ingredient and a photo. Description and allergens are optional and never block a
 * dish or appear in "N fields missing".
 */
export function missingFields(dish: ReviewDish): MissingField[] {
  const missing: MissingField[] = [];
  if ((dish.name?.trim().length ?? 0) < MIN_NAME_LENGTH) missing.push('name');
  if (isBlank(dish.category)) missing.push('category');
  if (
    !priceValid(dish.priceAmount) ||
    (dish.priceCurrency !== undefined &&
      (dish.priceCurrency === null ||
        !OwnerDishFieldsSchema.shape.priceCurrency.safeParse(dish.priceCurrency).success))
  )
    missing.push('price');
  if (dish.servingSize !== undefined && isBlank(dish.servingSize)) missing.push('servingSize');
  if (dish.ingredients.items.length === 0) missing.push('ingredients');
  if (isBlank(dish.photoId)) missing.push('photo');
  return missing;
}

const FIELD_LABEL: Record<MissingField, string> = {
  name: 'Name',
  price: 'Price',
  category: 'Category',
  servingSize: 'Serving Size',
  description: 'Description',
  ingredients: 'Ingredients',
  allergens: 'Allergens',
  photo: 'Photo',
};

/**
 * Status pill of one row (Figma S08/S10): "2 fields missing" or "Price Missing" (red/yellow) while a
 * required detail is missing; "Pending Review" when nothing is missing but the owner has not reviewed
 * the dish yet; "Ready" once it is reviewed. Only required fields count (see missingFields).
 */
export function dishStatus(dish: ReviewDish): DishStatus {
  const missing = missingFields(dish);
  const [first] = missing;
  if (first === undefined) {
    return dish.reviewed === false
      ? { ready: false, label: 'Pending Review', tone: 'information' }
      : { ready: true, label: 'Ready', tone: 'success' };
  }
  if (missing.length > 1) {
    return { ready: false, label: `${missing.length} fields missing`, tone: 'error' };
  }
  // A missing price is shown in red; one other missing detail in yellow.
  return {
    ready: false,
    label: `${FIELD_LABEL[first]} Missing`,
    tone: first === 'price' ? 'error' : 'warning',
  };
}

export function formatPrice(priceAmount: string | null, currency?: string | null): string {
  if (!priceValid(priceAmount)) return NOT_FOUND;
  if (currency === null || currency === '') return Number(priceAmount).toFixed(2);
  if (currency && currency !== 'USD') return `${Number(priceAmount).toFixed(2)} ${currency}`;
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
  // A confirmed "none" lists nothing, so it reads "no allergen recorded" (Figma shows this line).
  const allergensRecorded =
    dish.allergens.status === 'confirmed' && dish.allergens.items.length > 0;
  return allergensRecorded ? ingredients : `${ingredients} · no allergen recorded`;
}

/** The owner can complete verification only when at least one dish remains and every dish is Ready. */
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

// The dish fields the Add/Edit Dish form edits. The shape matches `OwnerDishFields` in
// packages/contracts/src/owner-menu.ts (the manual draft API, docs/owner-menu-workspace.md), so a
// saved or OCR draft can be passed in as-is and the form's value sent back unchanged.
// Kept as a local type so the console does not depend on the contracts package yet.

/** unknown: nobody checked yet. proposed: suggested (OCR or AI), not checked. confirmed: owner checked. */
export type FactStatus = 'unknown' | 'proposed' | 'confirmed';

/** Same nine codes as PublicMenuAllergenCodeSchema. */
export const ALLERGENS = [
  'milk',
  'egg',
  'fish',
  'crustacean shellfish',
  'nuts',
  'peanut',
  'wheat',
  'soy',
  'sesame',
] as const;
export type AllergenCode = (typeof ALLERGENS)[number];

export const ALLERGEN_LABEL: Record<AllergenCode, string> = {
  milk: 'Milk',
  egg: 'Egg',
  fish: 'Fish',
  'crustacean shellfish': 'Crustacean shellfish',
  nuts: 'Tree nuts',
  peanut: 'Peanut',
  wheat: 'Wheat',
  soy: 'Soy',
  sesame: 'Sesame',
};

export interface DishFields {
  name: string | null;
  category: string | null;
  description: string | null;
  /** Decimal string, for example "8.50". */
  priceAmount: string | null;
  /** ISO code, for example "USD". */
  priceCurrency: string | null;
  ingredients: { status: FactStatus; items: string[] };
  allergens: { status: FactStatus; items: AllergenCode[] };
  photoId: string | null;
}

export const emptyDish = (currency = 'USD'): DishFields => ({
  name: null,
  category: null,
  description: null,
  priceAmount: null,
  priceCurrency: currency,
  ingredients: { status: 'unknown', items: [] },
  allergens: { status: 'unknown', items: [] },
  photoId: null,
});

/** [input id, message]. The id is the field the error summary links to. */
export type FieldError = [string, string];

const PRICE = /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/;

/**
 * Checks before review (not before a draft save: drafts may be incomplete).
 * Unknown ingredients or allergens are allowed: they stay unknown and are never shown as "none".
 * Suggested (proposed) values must be checked first, so nothing unchecked reaches review.
 */
export function validateDish(
  v: DishFields,
  { hasPhoto, requirePhoto }: { hasPhoto: boolean; requirePhoto: boolean },
): FieldError[] {
  const er: FieldError[] = [];
  if ((v.name ?? '').trim().length < 2) er.push(['f-name', 'Enter a dish name.']);
  if (!(v.category ?? '').trim()) er.push(['f-cat', 'Choose a category.']);
  const price = (v.priceAmount ?? '').trim();
  if (!PRICE.test(price) || !(Number(price) > 0))
    er.push(['f-price', 'Enter a price greater than 0, with at most 2 decimals.']);
  if ((v.description ?? '').trim().length < 20)
    er.push(['f-desc', 'Write a description of at least 20 characters.']);
  if (v.ingredients.status !== 'unknown' && v.ingredients.items.length < 1)
    er.push(['f-ing', 'Add at least one ingredient, or mark ingredients as not checked yet.']);
  if (v.ingredients.status === 'proposed')
    er.push(['f-ing-ok', 'Check the suggested ingredients and confirm them.']);
  if (v.allergens.status === 'proposed')
    er.push(['f-alg-unknown', 'Check the suggested allergens and confirm them.']);
  if (requirePhoto && !hasPhoto) er.push(['f-photo', 'Add a photo of the dish.']);
  return er;
}

/** Changing the status keeps the contract rule: an unknown list is always empty. */
export function withAllergenStatus(v: DishFields, status: FactStatus): DishFields {
  return {
    ...v,
    allergens: { status, items: status === 'unknown' ? [] : v.allergens.items },
  };
}

export function toggleAllergen(v: DishFields, code: AllergenCode, on: boolean): DishFields {
  const items = on
    ? ALLERGENS.filter((a) => a === code || v.allergens.items.includes(a))
    : v.allergens.items.filter((a) => a !== code);
  return { ...v, allergens: { status: 'confirmed', items } };
}

/** What diners would be told about allergens. Unknown is never "none". */
export function allergenSummary(a: DishFields['allergens']): string {
  if (a.status !== 'confirmed') return 'Allergens not confirmed yet. Ask staff.';
  if (a.items.length === 0) return 'Contains none of the 9 listed allergens.';
  return `Contains: ${a.items.map((c) => ALLERGEN_LABEL[c]).join(', ')}.`;
}

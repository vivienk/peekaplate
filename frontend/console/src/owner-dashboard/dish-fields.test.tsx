import { describe, expect, it } from 'vitest';
import {
  allergenSummary,
  type DishFields,
  emptyDish,
  toggleAllergen,
  validateDish,
  withAllergenStatus,
} from './dish-fields';

const ready: DishFields = {
  name: 'Fictional soup',
  category: 'Soup',
  description: 'A warm carrot soup with fresh herbs.',
  priceAmount: '8.50',
  priceCurrency: 'USD',
  ingredients: { status: 'confirmed', items: ['Carrot'] },
  allergens: { status: 'unknown', items: [] },
  photoId: null,
};
const ids = (v: DishFields, hasPhoto = true) =>
  validateDish(v, { hasPhoto, requirePhoto: true }).map(([id]) => id);

describe('dish fields (owner-menu-workspace.md draft shape)', () => {
  it('starts empty with unknown ingredients and allergens, like a new API draft', () => {
    expect(emptyDish()).toEqual({
      name: null,
      category: null,
      description: null,
      priceAmount: null,
      priceCurrency: 'USD',
      ingredients: { status: 'unknown', items: [] },
      allergens: { status: 'unknown', items: [] },
      photoId: null,
    });
  });

  it('accepts a complete dish and keeps the #105 checks', () => {
    expect(ids(ready)).toEqual([]);
    expect(ids(emptyDish(), false)).toEqual(['f-name', 'f-cat', 'f-price', 'f-desc', 'f-photo']);
  });

  it('accepts only API prices: greater than 0 with at most 2 decimals', () => {
    for (const p of ['8', '8.5', '8.50']) expect(ids({ ...ready, priceAmount: p })).toEqual([]);
    for (const p of ['0', '8.505', '-1', 'abc', '08'])
      expect(ids({ ...ready, priceAmount: p })).toContain('f-price');
  });

  it('lets unknown ingredients and allergens through, but never unchecked suggestions', () => {
    expect(ids({ ...ready, ingredients: { status: 'unknown', items: [] } })).toEqual([]);
    expect(ids({ ...ready, ingredients: { status: 'proposed', items: ['Carrot'] } })).toEqual([
      'f-ing-ok',
    ]);
    expect(ids({ ...ready, ingredients: { status: 'confirmed', items: [] } })).toEqual(['f-ing']);
    expect(ids({ ...ready, allergens: { status: 'proposed', items: ['milk'] } })).toEqual([
      'f-alg-unknown',
    ]);
  });

  it('keeps the contract rule that an unknown allergen list is empty', () => {
    const milk = toggleAllergen(ready, 'milk', true);
    expect(milk.allergens).toEqual({ status: 'confirmed', items: ['milk'] });
    expect(withAllergenStatus(milk, 'unknown').allergens).toEqual({ status: 'unknown', items: [] });
    // Order follows the contract list, not the click order.
    expect(toggleAllergen(milk, 'egg', true).allergens.items).toEqual(['milk', 'egg']);
  });

  it('never tells diners "none" unless the owner confirmed it', () => {
    expect(allergenSummary({ status: 'unknown', items: [] })).toBe(
      'Allergens not confirmed yet. Ask staff.',
    );
    expect(allergenSummary({ status: 'proposed', items: ['milk'] })).toBe(
      'Allergens not confirmed yet. Ask staff.',
    );
    expect(allergenSummary({ status: 'confirmed', items: [] })).toBe(
      'Contains none of the 9 listed allergens.',
    );
    expect(allergenSummary({ status: 'confirmed', items: ['milk', 'nuts'] })).toBe(
      'Contains: Milk, Tree nuts.',
    );
  });
});

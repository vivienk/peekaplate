// Rules for the S10 dish table. The file is .tsx because the root Vitest config only runs
// frontend/console/**/*.test.tsx; a .test.ts here would be skipped silently.
import { describe, expect, it } from 'vitest';
import {
  addDish,
  categoryLabel,
  dishMeta,
  dishStatus,
  formatPrice,
  initialReview,
  isMenuReady,
  NOT_FOUND,
  type ReviewDish,
  removeDish,
  saveEdit,
  undoRemove,
} from './reviewDishes';

const dish = (over: Partial<ReviewDish> = {}): ReviewDish => ({
  id: 'd1',
  name: 'Avocado Toast',
  category: 'Breakfast',
  priceAmount: '14',
  description: 'Toasted sourdough with smashed avocado.',
  ingredients: { status: 'confirmed', items: ['avocado', 'bread'] },
  allergens: { status: 'confirmed', items: ['wheat'] },
  photoId: 'photo-1',
  ...over,
});

describe('dishStatus', () => {
  it('is Ready when every detail is present', () => {
    expect(dishStatus(dish())).toEqual({ ready: true, label: 'Ready', tone: 'success' });
  });

  it('names the field, in red, when only the price is missing', () => {
    for (const priceAmount of [null, '', '  ', 'Free', 'Infinity', '1e2', '1.234']) {
      expect(dishStatus(dish({ priceAmount }))).toEqual({
        ready: false,
        label: 'Price Missing',
        tone: 'error',
      });
    }
  });

  it('accepts the contract zero price and rejects an explicitly missing live currency', () => {
    expect(dishStatus(dish({ priceAmount: '0', priceCurrency: 'USD' })).ready).toBe(true);
    expect(dishStatus(dish({ priceCurrency: null })).ready).toBe(false);
  });

  it('names the field, in yellow, when only the category is missing', () => {
    for (const category of [null, '', '   ']) {
      expect(dishStatus(dish({ category }))).toEqual({
        ready: false,
        label: 'Category Missing',
        tone: 'warning',
      });
    }
  });

  it('names the field, in yellow, when only the serving size is missing', () => {
    expect(dishStatus(dish({ servingSize: null }))).toEqual({
      ready: false,
      label: 'Serving size (people) Missing',
      tone: 'warning',
    });
  });

  it('names any other single missing mandatory detail', () => {
    const cases: [Partial<ReviewDish>, string][] = [
      [{ photoId: null }, 'Photo Missing'],
      [{ name: null }, 'Name Missing'],
      [{ ingredients: { status: 'unknown', items: [] } }, 'Ingredients Missing'],
    ];
    for (const [over, label] of cases) {
      expect(dishStatus(dish(over))).toEqual({ ready: false, label, tone: 'warning' });
    }
  });

  it('does not count the optional description or allergens', () => {
    expect(dishStatus(dish({ description: null })).ready).toBe(true);
    expect(dishStatus(dish({ description: 'Too short' })).ready).toBe(true);
    expect(dishStatus(dish({ allergens: { status: 'unknown', items: [] } })).ready).toBe(true);
    // An AI-drafted (proposed) ingredient list still counts as present.
    expect(dishStatus(dish({ ingredients: { status: 'proposed', items: ['egg'] } })).ready).toBe(
      true,
    );
    // Missing optional details never add to the count.
    expect(
      dishStatus(
        dish({ priceAmount: null, description: null, allergens: { status: 'unknown', items: [] } }),
      ).label,
    ).toBe('Price Missing');
  });

  it('is Pending Review when nothing is missing but the dish was not reviewed yet', () => {
    expect(dishStatus(dish({ reviewed: false }))).toEqual({
      ready: false,
      label: 'Pending Review',
      tone: 'warning',
    });
    expect(dishStatus(dish({ reviewed: true })).label).toBe('Ready');
    // Missing details come first.
    expect(dishStatus(dish({ reviewed: false, priceAmount: null })).label).toBe('Price Missing');
  });

  it('shows N fields missing, in red, when several mandatory details are missing', () => {
    expect(dishStatus(dish({ priceAmount: null, category: null }))).toEqual({
      ready: false,
      label: '2 fields missing',
      tone: 'error',
    });
    expect(dishStatus(dish({ photoId: null, name: null })).label).toBe('2 fields missing');
    expect(
      dishStatus(dish({ priceAmount: null, category: null, servingSize: null, photoId: null }))
        .label,
    ).toBe('4 fields missing');
  });

  it('counts only the six mandatory details, never the optional ones', () => {
    const worst = dishStatus(
      dish({
        name: null,
        category: null,
        priceAmount: null,
        servingSize: null,
        description: null,
        ingredients: { status: 'unknown', items: [] },
        allergens: { status: 'unknown', items: [] },
        photoId: null,
      }),
    );
    expect(worst.label).toBe('6 fields missing');
    expect(worst.label).not.toMatch(/price|category|serving|photo|name|allergen|ingredient/i);
  });
});

describe('display text', () => {
  it('formats prices with two decimals and shows Not found when missing', () => {
    expect(formatPrice('14')).toBe('$14.00');
    expect(formatPrice('14.5')).toBe('$14.50');
    expect(formatPrice(null)).toBe(NOT_FOUND);
    expect(formatPrice('Free')).toBe(NOT_FOUND);
  });

  it('shows Not found for a missing category', () => {
    expect(categoryLabel(dish())).toBe('Breakfast');
    expect(categoryLabel(dish({ category: null }))).toBe(NOT_FOUND);
    expect(categoryLabel(dish({ category: ' ' }))).toBe(NOT_FOUND);
  });

  it('counts ingredients and handles one or none', () => {
    const confirmed = { status: 'confirmed', items: ['egg'] } as const;
    expect(dishMeta(dish({ ingredients: { status: 'confirmed', items: ['a'] } }))).toBe(
      '1 ingredient',
    );
    expect(dishMeta(dish())).toBe('2 ingredients');
    expect(
      dishMeta(dish({ ingredients: { status: 'unknown', items: [] }, allergens: confirmed })),
    ).toBe('No ingredients recorded');
  });

  it('says no allergen recorded unless the owner confirmed allergens', () => {
    for (const status of ['unknown', 'proposed'] as const) {
      expect(dishMeta(dish({ allergens: { status, items: ['egg'] } }))).toBe(
        '2 ingredients · no allergen recorded',
      );
    }
  });
});

describe('isMenuReady', () => {
  it('is false for an empty menu', () => {
    expect(isMenuReady([])).toBe(false);
  });

  it('is true only when every dish is Ready', () => {
    expect(isMenuReady([dish(), dish({ id: 'd2' })])).toBe(true);
    expect(isMenuReady([dish(), dish({ id: 'd2', priceAmount: null })])).toBe(false);
    expect(
      isMenuReady([dish(), dish({ id: 'd2', allergens: { status: 'proposed', items: ['milk'] } })]),
    ).toBe(false);
  });

  it('keeps proposed allergens in Pending Review until owner resolution', () => {
    expect(dishStatus(dish({ allergens: { status: 'proposed', items: ['milk'] } }))).toEqual({
      ready: false,
      label: 'Pending Review',
      tone: 'warning',
    });
  });
});

describe('remove and undo', () => {
  const state = initialReview([dish({ id: 'a' }), dish({ id: 'b' }), dish({ id: 'c' })]);

  it('removes a dish and remembers it and its position', () => {
    const next = removeDish(state, 'b');
    expect(next.dishes.map((d) => d.id)).toEqual(['a', 'c']);
    expect(next.removed?.dish.id).toBe('b');
    expect(next.removed?.index).toBe(1);
    expect(next.notice).toBe('removed');
  });

  it('ignores an unknown id', () => {
    expect(removeDish(state, 'zzz')).toBe(state);
  });

  it('restores the same dish at the same position with a restored notice', () => {
    const removed = removeDish(state, 'b');
    const restored = undoRemove(removed);
    expect(restored.dishes).toEqual(state.dishes);
    expect(restored.removed).toBeNull();
    expect(restored.notice).toBe('restored');
  });

  it('undo with nothing removed changes nothing', () => {
    expect(undoRemove(state)).toBe(state);
  });

  it('puts a removed last dish back at the end', () => {
    const restored = undoRemove(removeDish(state, 'c'));
    expect(restored.dishes.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('updates readiness from the dishes that remain', () => {
    const mixed = initialReview([dish({ id: 'a' }), dish({ id: 'b', priceAmount: null })]);
    expect(isMenuReady(mixed.dishes)).toBe(false);
    const removed = removeDish(mixed, 'b');
    expect(isMenuReady(removed.dishes)).toBe(true);
    expect(isMenuReady(undoRemove(removed).dishes)).toBe(false);
  });
});

describe('saveEdit and addDish', () => {
  const state = removeDish(initialReview([dish({ id: 'a' }), dish({ id: 'b' })]), 'b');

  it('replaces the edited dish and clears the pending Undo and notice', () => {
    const next = saveEdit(state, dish({ id: 'a', name: 'Changed' }));
    expect(next.dishes[0]?.name).toBe('Changed');
    expect(next.removed).toBeNull();
    expect(next.notice).toBeNull();
  });

  it('ignores an edit for a dish that is not in the list', () => {
    expect(saveEdit(state, dish({ id: 'nope' }))).toBe(state);
  });

  it('appends a new dish and does not add the same id twice', () => {
    const added = addDish(state, dish({ id: 'n' }));
    expect(added.dishes.map((d) => d.id)).toEqual(['a', 'n']);
    expect(added.removed).toBeNull();
    expect(addDish(added, dish({ id: 'n' }))).toBe(added);
  });
});

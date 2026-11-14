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
  ingredients: { status: 'confirmed', items: ['avocado', 'bread'] },
  allergens: { status: 'confirmed', items: ['wheat'] },
  ...over,
});

describe('dishStatus', () => {
  it('is Ready when price and category are present', () => {
    expect(dishStatus(dish())).toEqual({ ready: true, label: 'Ready', tone: 'success' });
  });

  it('is Price Missing when the price is null, blank or not a number', () => {
    for (const priceAmount of [null, '', '  ', 'Free']) {
      expect(dishStatus(dish({ priceAmount }))).toEqual({
        ready: false,
        label: 'Price Missing',
        tone: 'error',
      });
    }
  });

  it('is Category Missing when the category is null or blank', () => {
    for (const category of [null, '', '   ']) {
      expect(dishStatus(dish({ category }))).toEqual({
        ready: false,
        label: 'Category Missing',
        tone: 'warning',
      });
    }
  });

  it('is never Ready when both are missing', () => {
    const status = dishStatus(dish({ priceAmount: null, category: null }));
    expect(status.ready).toBe(false);
    expect(status.label).toBe('Price and Category Missing');
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

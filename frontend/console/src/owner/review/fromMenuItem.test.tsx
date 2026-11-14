import { describe, expect, it } from 'vitest';
import { type DashboardMenuItem, menuItemToReviewDish } from './fromMenuItem';
import { dishStatus } from './reviewDishes';

const item = (over: Partial<DashboardMenuItem> = {}): DashboardMenuItem => ({
  id: 'avotoast',
  name: 'Avocado Toast',
  cat: 'Breakfast',
  price: 14,
  ing: ['Seeded bread', 'Avocado', 'Poached egg'],
  aiIng: [],
  aiReviewed: false,
  ...over,
});

describe('dashboard menu item to S10 review row', () => {
  it('keeps the dish id, name, category and price from the shared menu data', () => {
    expect(menuItemToReviewDish(item())).toMatchObject({
      id: 'avotoast',
      name: 'Avocado Toast',
      category: 'Breakfast',
      priceAmount: '14',
    });
  });

  it('turns an empty price or category into a missing value, so the row is not Ready', () => {
    const noPrice = menuItemToReviewDish(item({ price: '' }));
    expect(noPrice.priceAmount).toBeNull();
    expect(dishStatus(noPrice).label).toBe('Price Missing');
    const noCategory = menuItemToReviewDish(item({ cat: ' ' }));
    expect(noCategory.category).toBeNull();
    expect(dishStatus(noCategory).label).toBe('Category Missing');
    expect(dishStatus(menuItemToReviewDish(item())).ready).toBe(true);
  });

  it('never invents allergens: none listed is unknown, listed is confirmed', () => {
    expect(menuItemToReviewDish(item()).allergens).toEqual({ status: 'unknown', items: [] });
    expect(menuItemToReviewDish(item({ alg: ['egg'] })).allergens).toEqual({
      status: 'confirmed',
      items: ['egg'],
    });
  });

  it('keeps unreviewed AI suggestions as proposed, not confirmed', () => {
    const suggested = menuItemToReviewDish(
      item({ ing: ['Rice'], aiIng: ['Rice'], alg: ['fish'], aiAlg: ['fish'] }),
    );
    expect(suggested.ingredients.status).toBe('proposed');
    expect(suggested.allergens.status).toBe('proposed');
    const reviewed = menuItemToReviewDish(
      item({ ing: ['Rice'], aiIng: ['Rice'], aiReviewed: true }),
    );
    expect(reviewed.ingredients.status).toBe('confirmed');
  });

  it('gives a draft without an id a stable placeholder id', () => {
    expect(menuItemToReviewDish(item({ id: null, name: 'Soup' })).id).toBe('new-Soup');
  });
});

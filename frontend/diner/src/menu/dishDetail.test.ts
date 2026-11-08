import { describe, expect, it } from 'vitest';
import { renderDishDetail } from './dishDetail';
import type { CompleteDish } from './types';

const NOTE = 'For allergy questions, please ask the restaurant staff.';

const render = (allergens: string[]): string => {
  const container = {
    innerHTML: '',
    querySelector: () => null,
  } as unknown as HTMLElement;
  renderDishDetail(
    container,
    {
      kind: 'complete',
      dishId: 'd',
      dishRevisionId: 'r',
      categoryId: 'c',
      categoryName: 'Cat',
      name: 'Dish',
      description: 'Desc',
      price: { amount: '1.00', currency: 'USD' },
      ingredients: [{ ingredientId: 'i', name: 'Leaf', description: null }],
      allergens,
      dietary: [],
      images: null,
    } as unknown as CompleteDish,
    () => {},
  );
  return container.innerHTML;
};

const count = (html: string) => html.split(NOTE).length - 1;

describe('dish detail allergen note', () => {
  it('shows the note once, under Contains, when no allergens are confirmed', () => {
    const html = render([]);
    expect(count(html)).toBe(1);
    expect(html).not.toContain('pp-chip-group');
    expect(html.indexOf('Contains')).toBeLessThan(html.indexOf(NOTE));
  });

  it('shows chips under Contains and the note once, after them, when confirmed', () => {
    const html = render(['Milk']);
    expect(count(html)).toBe(1);
    expect(html).toContain('Milk');
    expect(html.indexOf('pp-chip-group')).toBeLessThan(html.indexOf(NOTE));
  });

  it('never says there are no allergens', () => {
    expect(render([]).toLowerCase()).not.toContain('no allergens');
  });
});

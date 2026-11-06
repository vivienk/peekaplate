import { describe, expect, it } from 'vitest';
import { toMenu } from './adapter';
import type { WireDish, WireMenuBundle } from './wire';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const img = (name: string) => ({
  url: `https://example.com/${name}.jpg`,
  width: 400,
  height: 300,
  alt: name,
});

const dish = (over: Record<string, unknown> = {}) =>
  ({
    dish_id: id(1),
    dish_revision_id: id(2),
    complete: true,
    name: 'Test Dish',
    description: 'Test',
    price: { amount: '12.50', currency: 'USD' },
    ingredients: [{ ingredient_id: id(3), name: 'Ingredient', description: null }],
    allergens: [],
    dietary: [],
    images: { card: img('card'), detail: img('detail') },
    ...over,
  }) as unknown as WireDish;

const bundle = (categories: WireDish[][] = [[dish()]]) =>
  ({
    schema_version: 1,
    venue_id: id(10),
    menu_id: id(11),
    menu_revision_id: id(12),
    restaurant: { name: 'Test Restaurant', logo: null },
    categories: categories.map((dishes, i) => ({
      category_id: id(20 + i),
      name: `Category ${i}`,
      dishes,
    })),
  }) as unknown as WireMenuBundle;

const status = (b: WireMenuBundle) => toMenu(b, 'published', 'rev1').status;

describe('toMenu validates published bundles', () => {
  it('valid bundle -> ready, with no fixture notice', () => {
    const result = toMenu(bundle(), 'published', 'rev1');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.menu.venueId).toBe(id(10));
    expect(result.menu.notice).toBeNull();
  });

  it('missing price -> error', () => {
    expect(status(bundle([[dish({ price: undefined })]]))).toBe('error');
  });

  it('missing currency -> error', () => {
    expect(status(bundle([[dish({ price: { amount: '12.50' } })]]))).toBe('error');
  });

  it('missing ingredients -> error', () => {
    expect(status(bundle([[dish({ ingredients: undefined })]]))).toBe('error');
  });

  it('invalid currency -> error', () => {
    expect(status(bundle([[dish({ price: { amount: '12.50', currency: 'usd' } })]]))).toBe('error');
  });

  it('duplicate dish_id -> error', () => {
    expect(status(bundle([[dish()], [dish()]]))).toBe('error');
  });

  it('unknown extra field -> error', () => {
    expect(status(bundle([[dish({ unknownField: 'x' })]]))).toBe('error');
  });

  it('the same invalid bundle is NOT rejected for fixtures', () => {
    const result = toMenu(bundle([[dish({ unknownField: 'x' })]]), 'fixture', 'rev1');
    expect(result.status).toBe('ready');
  });
});

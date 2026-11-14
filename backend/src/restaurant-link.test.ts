import { describe, expect, it } from 'vitest';
import { restaurantSlugSeed } from './restaurant-link';

describe('server restaurant URL seed', () => {
  it.each([
    ['Noka Ramen', 'noka_ramen'],
    ['  Ember & Stone!  ', 'ember_stone'],
    ['Café Noël', 'cafe_noel'],
    ['東京 🍜', 'restaurant'],
    ['owner', 'restaurant_owner'],
    ['CONSTRUCTOR', 'restaurant_constructor'],
  ])('normalizes %s without treating it as a URL or authority', (name, expected) => {
    expect(restaurantSlugSeed(name)).toBe(expected);
  });
  it('leaves room for collision suffixes and ends on a letter or digit', () => {
    const value = restaurantSlugSeed('Long restaurant '.repeat(30));
    expect(value.length).toBeLessThanOrEqual(48);
    expect(value).toMatch(/^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/);
  });
});

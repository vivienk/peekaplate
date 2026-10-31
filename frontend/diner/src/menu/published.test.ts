import { describe, expect, it } from 'vitest';
import {
  deliveryToMenu,
  parsePublishedDelivery,
  publicBundleToWire,
} from './published';

const validDelivery = {
  response: {
    schemaVersion: 1,
    venueId: '11111111-1111-4111-8111-111111111111',
    menuId: '22222222-2222-4222-8222-222222222222',
    menuRevisionId: '33333333-3333-4333-8333-333333333333',
    publicationId: '44444444-4444-4444-8444-444444444444',
    publicationHash: 'a'.repeat(64),
    availabilityVersion: 1,
    tier: 'T0',
    bundle: {
      url: 'https://example.test/bundle.json',
      contentHash: 'b'.repeat(64),
      assetManifestHash: 'c'.repeat(64),
    },
    menuToken: 'token',
    tokenExpiresAt: '2026-11-01T00:00:00.000Z',
  },
  content: {
    schema_version: 1,
    venue_id: '11111111-1111-4111-8111-111111111111',
    menu_id: '22222222-2222-4222-8222-222222222222',
    menu_revision_id: '33333333-3333-4333-8333-333333333333',
    restaurant: { name: 'Test Restaurant', logo: null },
    categories: [
      {
        category_id: '55555555-5555-4555-8555-555555555555',
        name: 'Breakfast',
        dishes: [
          {
            dish_id: '66666666-6666-4666-8666-666666666666',
            dish_revision_id: '77777777-7777-4777-8777-777777777777',
            complete: false,
          },
          {
            dish_id: '88888888-8888-4888-8888-888888888888',
            dish_revision_id: '99999999-9999-4999-8999-999999999999',
            complete: true,
            name: 'Toast',
            description: 'Toast',
            price: { amount: '1.00', currency: 'USD' },
            ingredients: [{ ingredient_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Bread', description: null }],
            allergens: null,
            dietary: ['vegan'],
            images: {
              card: { url: 'https://example.test/card.jpg', width: 1, height: 1, alt: 'card' },
              detail: { url: 'https://example.test/detail.jpg', width: 1, height: 1, alt: 'detail' },
            },
          },
        ],
      },
    ],
  },
};

describe('published adapter', () => {
  it('validates a valid delivery', () => {
    const delivery = parsePublishedDelivery(validDelivery);
    expect(delivery.response.publicationId).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('maps a valid delivery into the internal menu', () => {
    const delivery = parsePublishedDelivery(validDelivery);
    const result = deliveryToMenu(delivery);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.menu.source).toBe('published');
    expect(result.menu.notice).toBeNull();
  });

  it('rejects an unknown key', () => {
    const invalid = structuredClone(validDelivery) as Record<string, unknown>;
    (invalid.content as Record<string, unknown>).unknown_field = true;
    expect(() => parsePublishedDelivery(invalid)).toThrow();
  });

  it('rejects a missing alt', () => {
    const invalid = structuredClone(validDelivery) as any;
    invalid.content.categories[0].dishes[1].images.card.alt = '';
    expect(() => parsePublishedDelivery(invalid)).toThrow();
  });

  it('rejects a non-https image URL', () => {
    const invalid = structuredClone(validDelivery) as any;
    invalid.content.categories[0].dishes[1].images.card.url = 'http://example.test/card.jpg';
    expect(() => parsePublishedDelivery(invalid)).toThrow();
  });

  it('rejects a duplicate dish ID', () => {
    const invalid = structuredClone(validDelivery) as any;
    invalid.content.categories[0].dishes[1].dish_id = invalid.content.categories[0].dishes[0].dish_id;
    expect(() => parsePublishedDelivery(invalid)).toThrow();
  });

  it('maps allergens null to an omitted allergen list', () => {
    const delivery = parsePublishedDelivery(validDelivery);
    const result = deliveryToMenu(delivery);
    if (result.status !== 'ready') throw new Error('expected ready');
    const dish = result.menu.categories[0]?.dishes[1];
    if (!dish || dish.kind !== 'complete') throw new Error('expected complete');
    expect(dish.allergens).toEqual([]);
  });

  it('maps dietary codes to display values', () => {
    const delivery = parsePublishedDelivery(validDelivery);
    const result = deliveryToMenu(delivery);
    if (result.status !== 'ready') throw new Error('expected ready');
    const dish = result.menu.categories[0]?.dishes[1];
    if (!dish || dish.kind !== 'complete') throw new Error('expected complete');
    expect(dish.dietary).toEqual(['Vegan']);
  });

  it('keeps publicBundleToWire as the single mapping', () => {
    const delivery = parsePublishedDelivery(validDelivery);
    const wire = publicBundleToWire(delivery.content);
    expect(wire.venue_id).toBe('11111111-1111-4111-8111-111111111111');
  });
});
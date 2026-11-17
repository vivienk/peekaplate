import { describe, expect, it } from 'vitest';
import { extractStructuredMenuItems, parseHtmlSource } from './parser';

describe('restaurant URL structured menu parsing', () => {
  it('preserves genuine JSON-LD MenuItem names, descriptions and prices as review evidence', () => {
    const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Restaurant","name":"Cafe",
      "hasMenu":{"@type":"Menu","hasMenuSection":[{"@type":"MenuSection",
        "hasMenuItem":[{"@type":"MenuItem","name":"Miso Ramen",
          "description":"Miso broth, noodles","offers":{"@type":"Offer",
          "price":"18.50","priceCurrency":"USD"}}]}]}}
    </script></head><body><nav>Privacy Contact</nav><main><h1>Welcome</h1></main></body></html>`;
    const parsed = parseHtmlSource(html, 'restaurant', 'https://restaurant.example/');
    expect(parsed.hasStructuredMenu).toBe(true);
    expect(parsed.segments[0]).toMatchObject({
      text: 'Miso Ramen — Miso broth, noodles — 18.50',
      is_menu_scope: true,
      metadata: {
        schema_type: 'MenuItem',
        name: 'Miso Ramen',
        description: 'Miso broth, noodles',
        price_text: '18.50',
        price_currency: 'USD',
      },
    });
    expect(parsed.segments.some((segment) => segment.text.includes('Privacy Contact'))).toBe(false);
  });

  it('does not misclassify generic Product or Restaurant structured data as dishes', () => {
    const result = extractStructuredMenuItems({
      '@graph': [
        { '@type': 'Restaurant', name: 'Restaurant Name' },
        { '@type': 'Product', name: 'Gift Card', offers: { price: '20' } },
      ],
    });
    expect(result).toEqual([]);
  });

  it('does not invent missing prices, currency or names', () => {
    const result = extractStructuredMenuItems({
      '@graph': [
        { '@type': 'MenuItem', name: 'Garlic Noodles', offers: { price: 'call us' } },
        { '@type': 'MenuItem', offers: { price: '10.00', priceCurrency: 'USD' } },
      ],
    });
    expect(result).toEqual([{ name: 'Garlic Noodles' }]);
  });

  it('caps nested menu items and handles malformed JSON without throwing', () => {
    const parsed = parseHtmlSource(
      '<script type="application/ld+json">{invalid}</script><p>Soup $8</p>',
      'restaurant',
    );
    expect(parsed.hasStructuredMenu).toBe(false);
    expect(parsed.segments.some((segment) => segment.text.includes('Soup $8'))).toBe(true);
    expect(
      extractStructuredMenuItems(
        Array.from({ length: 200 }, (_, i) => ({
          '@type': 'MenuItem',
          name: `Dish ${i}`,
        })),
      ),
    ).toHaveLength(150);
  });
});

import { describe, expect, it } from 'vitest';
import { createFixtureMenuSource, NO_ICON_ALLERGEN, NO_ICON_INGREDIENT } from './fixtures';
import {
  allergenIcon,
  dietaryIcon,
  generatedIngredientIcon,
  iconKey,
  ingredientIcon,
  UI_ICONS,
} from './icons';
import { ALLERGENS, DIETARY_VALUES } from './types';

// Vite inlines small SVGs as data: URLs and emits larger ones as .svg files.
const svgUrl = /^data:image\/svg\+xml|\.svg($|\?)/;

describe('menu icons', () => {
  it('resolves exported coconut art only by exact label and bundled content file', () => {
    const file = `${'a'.repeat(64)}.png`;
    const catalogue = { coconut: file };
    const modules = { [`../assets/icons/generated-ingredients/${file}`]: '/assets/coconut.png' };
    expect(generatedIngredientIcon('  COCONUT  ', catalogue, modules)).toBe('/assets/coconut.png');
    expect(generatedIngredientIcon('Coconut milk', catalogue, modules)).toBeNull();
    expect(generatedIngredientIcon('Coconut', catalogue, {})).toBeNull();
    expect(
      generatedIngredientIcon('Coconut', { coconut: 'https://example.com/icon.png' }, modules),
    ).toBeNull();
    expect(generatedIngredientIcon('toString', {}, modules)).toBeNull();
  });
  it('has an icon for every approved P0 allergen, by code and by label', () => {
    for (const { code, label } of ALLERGENS) {
      expect(allergenIcon(code), code).toMatch(svgUrl);
      expect(allergenIcon(label), label).toBe(allergenIcon(code));
    }
  });

  it('shows the Nuts icon for older "tree nut" data, and none for values outside P0', () => {
    expect(allergenIcon('tree nut')).toBe(allergenIcon('nuts'));
    expect(allergenIcon('Tree nuts')).toBe(allergenIcon('nuts'));
    expect(allergenIcon(NO_ICON_ALLERGEN)).toBeNull();
    expect(allergenIcon('gluten')).toBeNull();
  });

  it('has an icon for every dietary value', () => {
    for (const value of DIETARY_VALUES) expect(dietaryIcon(value), value).toMatch(svgUrl);
    expect(dietaryIcon('Keto')).toBeNull();
  });

  it('matches ingredient icons by exact name, ignoring case and spacing only', () => {
    expect(ingredientIcon('Cherry tomato')).toMatch(svgUrl);
    expect(ingredientIcon('Cherry tomato')).not.toBe(ingredientIcon('Avocado'));
    expect(ingredientIcon('  cherry   TOMATO ')).toBe(ingredientIcon('Cherry tomato'));
    expect(ingredientIcon('Cherry tomatoes')).toBeNull();
    expect(ingredientIcon(NO_ICON_INGREDIENT)).toBeNull();
    expect(iconKey('House Sauce')).toBe('house-sauce');
  });

  it('covers every demo ingredient that has a Figma icon, and leaves the no-icon case', async () => {
    const result = await createFixtureMenuSource('demo').load();
    if (result.status !== 'ready') throw new Error('demo fixture did not load');
    const names = result.menu.categories.flatMap((c) =>
      c.dishes.flatMap((d) => (d.kind === 'complete' ? d.ingredients.map((i) => i.name) : [])),
    );
    const withIcon = names.filter((n) => ingredientIcon(n));
    expect(withIcon).toEqual(
      expect.arrayContaining([
        'Avocado',
        'Cherry tomato',
        'Mixed greens',
        'Sweet potato',
        'Salmon',
      ]),
    );
    expect(names).toContain(NO_ICON_INGREDIENT);
  });

  it('exposes the heart and search UI icons', () => {
    expect(UI_ICONS.heart).toMatch(svgUrl);
    expect(UI_ICONS.search).toMatch(svgUrl);
  });
});

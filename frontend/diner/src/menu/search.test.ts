import { afterEach, describe, expect, it, vi } from 'vitest';
import { toMenu } from './adapter';
import { createFixtureMenuSource, DISH, NO_ICON_ALLERGEN, NO_ICON_INGREDIENT } from './fixtures';
import { searchMenu } from './search';
import { ALLERGENS, type Menu } from './types';
import type { WireCompleteDish } from './wire';

async function loadMenu(scenario: Parameters<typeof createFixtureMenuSource>[0]): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchMenu', () => {
  it('finds a dish by part of its name, ignoring case', async () => {
    const menu = await loadMenu('edge-cases');
    expect(searchMenu(menu, 'avocado toast').dishIds).toEqual([DISH.avocadoToast]);
    expect(searchMenu(menu, 'AVOCADO   Toast').dishIds).toEqual([DISH.avocadoToast]);
  });

  it('returns matches from every category in menu order', async () => {
    const menu = await loadMenu('edge-cases');
    expect(searchMenu(menu, 'toast').dishIds).toEqual([
      DISH.avocadoToast,
      DISH.briocheFrenchToast,
      DISH.longName,
    ]);
  });

  it('finds every dish in a category by part of the category name', async () => {
    const menu = await loadMenu('edge-cases');
    expect(searchMenu(menu, 'bowls').dishIds).toEqual([DISH.harvestPowerBowl, DISH.salmonPokeBowl]);
  });

  it('finds the Harvest Power Bowl by its Avocado ingredient, as in Figma', async () => {
    const menu = await loadMenu('demo');
    expect(searchMenu(menu, 'Avocado').dishIds).toEqual([
      DISH.avocadoToast,
      DISH.harvestPowerBowl,
      DISH.gardenAvocadoSalad,
    ]);
  });

  it('finds a dish by part of an ingredient name, including one with no icon', async () => {
    const menu = await loadMenu('edge-cases');
    expect(searchMenu(menu, 'hollanda').dishIds).toEqual([DISH.eggsBenedict]);
    expect(searchMenu(menu, NO_ICON_INGREDIENT).dishIds).toEqual([DISH.eggsBenedict]);
  });

  it('never searches the description', async () => {
    const menu = await loadMenu('edge-cases');
    // "flaky salt" appears only in the long-name dish's description.
    expect(searchMenu(menu, 'flaky').dishIds).toEqual([]);
  });

  it('never matches "gluten" to the Gluten-free dietary value, but shows the allergy line', async () => {
    // The approved P0 list has Wheat, not Gluten, so "gluten" matches no chip.
    expect(searchMenu(await loadMenu('edge-cases'), 'gluten')).toEqual({
      dishIds: [],
      allergyNotice: true,
    });
  });

  it('matches the Wheat allergen, including the dish that also lists Gluten-free', async () => {
    const result = searchMenu(await loadMenu('edge-cases'), 'wheat');
    expect(result.dishIds).toEqual([
      DISH.avocadoToast,
      DISH.eggsBenedict,
      DISH.berryPancakeStack,
      DISH.briocheFrenchToast,
      DISH.longName,
    ]);
    expect(result.allergyNotice).toBe(true);
  });

  it('matches "gluten-free" to the Gluten-free dietary value only, skipping the conflict dish', async () => {
    const menu = await loadMenu('edge-cases');
    for (const query of ['gluten-free', 'Gluten Free', 'GLUTENFREE', '  gluten - free ']) {
      const result = searchMenu(menu, query);
      expect(result.dishIds).toEqual([DISH.harvestPowerBowl]);
      expect(result.allergyNotice).toBe(true);
    }
  });

  it('matches allergen values on the whole chip label, not part of it', async () => {
    const menu = await loadMenu('edge-cases');
    expect(searchMenu(menu, 'sesame').dishIds).toEqual([
      DISH.salmonPokeBowl,
      DISH.gardenAvocadoSalad,
    ]);
    expect(searchMenu(menu, 'sesa')).toEqual({ dishIds: [], allergyNotice: false });
  });

  it('matches an approved allergen by its code or its label', async () => {
    const menu = await loadMenu('edge-cases');
    for (const query of ['peanut', 'Peanuts']) {
      expect(searchMenu(menu, query)).toEqual({
        dishIds: [DISH.gardenAvocadoSalad],
        allergyNotice: true,
      });
    }
    const eggDishes = [
      DISH.avocadoToast,
      DISH.eggsBenedict,
      DISH.berryPancakeStack,
      DISH.briocheFrenchToast,
    ];
    expect(searchMenu(menu, 'egg').dishIds).toEqual(eggDishes);
    expect(searchMenu(menu, 'eggs').dishIds).toEqual(eggDishes);
  });

  it('matches other names for an approved allergen, like "soya" and "sesame seeds"', async () => {
    const menu = await loadMenu('edge-cases');
    for (const query of ['soya', 'Soybean', 'soy']) {
      expect(searchMenu(menu, query)).toEqual({
        dishIds: [DISH.salmonPokeBowl, DISH.gardenAvocadoSalad],
        allergyNotice: true,
      });
    }
    expect(searchMenu(menu, 'sesame seeds').dishIds).toEqual([
      DISH.salmonPokeBowl,
      DISH.gardenAvocadoSalad,
    ]);
    for (const query of ['soya', 'sesame seeds']) {
      expect(searchMenu(await loadMenu('layout-20'), query)).toEqual({
        dishIds: [],
        allergyNotice: true,
      });
    }
  });

  it('finds both nut and peanut dishes for "nuts", and keeps the old "tree nut" names', () => {
    // The P0 nut code is "nuts" (Nov 1), "tree nut" before #59 adopts it; both must work.
    const nutCodes: readonly string[] = ['nuts', 'tree nut'];
    const nutCode = ALLERGENS.find((a) => nutCodes.includes(a.code))?.code;
    if (!nutCode) throw new Error('expected a P0 nut allergen');
    const dish = (n: number, allergens: string[]): WireCompleteDish => ({
      dish_id: `d${n}`,
      dish_revision_id: `r${n}`,
      complete: true,
      name: `Dish ${n}`,
      description: '',
      price: { amount: '1.00', currency: 'USD' },
      ingredients: [{ ingredient_id: `i${n}`, name: 'Rice', description: null }],
      dietary: [],
      allergens,
      images: null,
    });
    const result = toMenu(
      {
        schema_version: 1,
        venue_id: 'v',
        menu_id: 'm',
        menu_revision_id: 'mr',
        restaurant: { name: 'Test', logo: null },
        categories: [
          {
            category_id: 'c',
            name: 'Mains',
            dishes: [dish(1, [nutCode]), dish(2, ['peanut']), dish(3, ['milk'])],
          },
        ],
      },
      'fixture',
      'p',
    );
    if (result.status !== 'ready') throw new Error('expected a ready menu');
    for (const query of ['nuts', 'Nuts', 'nut']) {
      expect(searchMenu(result.menu, query)).toEqual({
        dishIds: ['d1', 'd2'],
        allergyNotice: true,
      });
    }
    for (const query of ['tree nut', 'Tree nuts']) {
      expect(searchMenu(result.menu, query).dishIds).toEqual(['d1']);
    }
    expect(searchMenu(result.menu, 'peanuts').dishIds).toEqual(['d2']);
  });

  it('finds an allergen value that has no icon', async () => {
    const result = searchMenu(await loadMenu('edge-cases'), NO_ICON_ALLERGEN);
    expect(result.dishIds).toEqual([DISH.gardenAvocadoSalad]);
    expect(result.allergyNotice).toBe(true);
  });

  it('shows the allergy line for an allergen no dish on this menu lists', async () => {
    const menu = await loadMenu('edge-cases');
    for (const query of ['Shellfish', 'crustacean shellfish', 'celery', 'dairy']) {
      expect(searchMenu(menu, query)).toEqual({ dishIds: [], allergyNotice: true });
    }
    expect(searchMenu(await loadMenu('layout-20'), 'mustard')).toEqual({
      dishIds: [],
      allergyNotice: true,
    });
  });

  it('returns no results and no allergy line for an unknown word', async () => {
    const menu = await loadMenu('edge-cases');
    expect(searchMenu(menu, 'pizza')).toEqual({ dishIds: [], allergyNotice: false });
  });

  it('keeps the allergy line for a dietary value no dish has', async () => {
    expect(searchMenu(await loadMenu('layout-20'), 'vegan')).toEqual({
      dishIds: [],
      allergyNotice: true,
    });
  });

  it('never returns incomplete dishes', async () => {
    const menu = await loadMenu('edge-cases');
    // The empty-ingredient dish's draft name, and a category that holds an incomplete dish.
    expect(searchMenu(menu, 'Seasonal Green Salad').dishIds).toEqual([]);
    const salads = searchMenu(menu, 'salads').dishIds;
    expect(salads).toEqual([DISH.gardenAvocadoSalad, DISH.longName]);
    expect(searchMenu(menu, 'brunch').dishIds).not.toContain(DISH.incomplete);
  });

  it('returns nothing for an empty or blank query', async () => {
    const menu = await loadMenu('edge-cases');
    for (const query of ['', '   ', '-']) {
      expect(searchMenu(menu, query)).toEqual({ dishIds: [], allergyNotice: false });
    }
  });

  it('makes no network call and logs nothing', async () => {
    const menu = await loadMenu('edge-cases');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    searchMenu(menu, 'gluten');
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureMenuSource, DISH, NO_ICON_ALLERGEN, NO_ICON_INGREDIENT } from './fixtures';
import { searchMenu } from './search';
import type { Menu } from './types';

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
    for (const query of ['tree nut', 'Tree nuts']) {
      expect(searchMenu(menu, query).dishIds).toEqual([DISH.gardenAvocadoSalad]);
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

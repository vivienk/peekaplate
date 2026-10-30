import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeDishes } from '../menu/adapter';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import { searchMenu } from '../menu/search';
import type { Menu } from '../menu/types';
import { isSelectable, pickerOptions, selectOption } from './picker';

async function loadMenu(scenario: Parameters<typeof createFixtureMenuSource>[0]): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

// The same menu with only the given dishes left, for the one-dish and empty-list cases.
function onlyDishes(menu: Menu, keep: (dishId: string) => boolean): Menu {
  return {
    ...menu,
    categories: menu.categories.map((c) => ({
      ...c,
      dishes: c.dishes.filter((d) => keep(d.dishId)),
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pickerOptions', () => {
  it('offers every other complete dish in menu order, without the kept dish', async () => {
    const menu = await loadMenu('demo');
    expect(pickerOptions(menu, [DISH.avocadoToast]).dishIds).toEqual([
      DISH.eggsBenedict,
      DISH.harvestPowerBowl,
      DISH.salmonPokeBowl,
      DISH.gardenAvocadoSalad,
    ]);
  });

  it('never offers incomplete dishes', async () => {
    const menu = await loadMenu('edge-cases');
    const { dishIds } = pickerOptions(menu, [DISH.harvestPowerBowl]);
    expect(dishIds).not.toContain(DISH.incomplete);
    expect(dishIds).not.toContain(DISH.noIngredients);
    expect(dishIds).toHaveLength(completeDishes(menu).length - 1);
  });

  it('excludes both shown dishes when replacing one side', async () => {
    const menu = await loadMenu('demo');
    expect(pickerOptions(menu, [DISH.avocadoToast, DISH.harvestPowerBowl]).dishIds).toEqual([
      DISH.eggsBenedict,
      DISH.salmonPokeBowl,
      DISH.gardenAvocadoSalad,
    ]);
  });

  it('searches with the same rules as the menu search', async () => {
    const menu = await loadMenu('edge-cases');
    // A name, a category, an ingredient, gluten vs gluten-free, no results, an incomplete dish.
    for (const query of [
      'Classic Eggs',
      'bowls',
      'avocado',
      'gluten',
      'gluten-free',
      'pizza',
      'Seasonal Green Salad',
    ]) {
      expect(pickerOptions(menu, [], query)).toEqual(searchMenu(menu, query));
    }
  });

  it('removes the kept dish from search results but keeps the allergy line', async () => {
    const menu = await loadMenu('edge-cases');
    expect(pickerOptions(menu, [DISH.harvestPowerBowl], 'bowls').dishIds).toEqual([
      DISH.salmonPokeBowl,
    ]);
    expect(pickerOptions(menu, [DISH.harvestPowerBowl], 'gluten-free')).toEqual({
      dishIds: [],
      allergyNotice: true,
    });
  });

  it('offers nothing when the kept dish is the only dish on the menu', async () => {
    const menu = onlyDishes(await loadMenu('demo'), (id) => id === DISH.avocadoToast);
    expect(pickerOptions(menu, [DISH.avocadoToast]).dishIds).toEqual([]);
  });

  it('offers nothing when every other dish is incomplete', async () => {
    const menu = onlyDishes(
      await loadMenu('edge-cases'),
      (id) => id === DISH.avocadoToast || id === DISH.incomplete || id === DISH.noIngredients,
    );
    expect(pickerOptions(menu, [DISH.avocadoToast]).dishIds).toEqual([]);
  });

  it('makes no network call and logs nothing', async () => {
    const menu = await loadMenu('edge-cases');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    pickerOptions(menu, [DISH.avocadoToast], 'wheat');
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('selectOption', () => {
  it('keeps one selection at a time: picking another replaces the previous one', async () => {
    const menu = await loadMenu('demo');
    const first = selectOption(menu, [DISH.avocadoToast], null, DISH.eggsBenedict);
    expect(first).toBe(DISH.eggsBenedict);
    expect(selectOption(menu, [DISH.avocadoToast], first, DISH.salmonPokeBowl)).toBe(
      DISH.salmonPokeBowl,
    );
  });

  it('blocks comparing a dish with itself', async () => {
    const menu = await loadMenu('demo');
    expect(selectOption(menu, [DISH.avocadoToast], null, DISH.avocadoToast)).toBeNull();
    expect(selectOption(menu, [DISH.avocadoToast], DISH.eggsBenedict, DISH.avocadoToast)).toBe(
      DISH.eggsBenedict,
    );
  });

  it('blocks both shown dishes when replacing', async () => {
    const menu = await loadMenu('demo');
    const shown = [DISH.avocadoToast, DISH.harvestPowerBowl];
    for (const dishId of shown) expect(isSelectable(menu, shown, dishId)).toBe(false);
    expect(isSelectable(menu, shown, DISH.salmonPokeBowl)).toBe(true);
  });

  it('ignores incomplete and unknown dishes', async () => {
    const menu = await loadMenu('edge-cases');
    for (const dishId of [DISH.incomplete, DISH.noIngredients, 'not-a-dish']) {
      expect(selectOption(menu, [DISH.avocadoToast], null, dishId)).toBeNull();
    }
  });
});

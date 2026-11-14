import { describe, expect, it } from 'vitest';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import type { Menu } from '../menu/types';
import { pickerViewState } from './pickerScreen';

async function loadMenu(scenario: Parameters<typeof createFixtureMenuSource>[0]): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

// The same menu with only the given dishes left, for the one-dish and empty-list cases.
function onlyDishes(menu: Menu, keep: readonly string[]): Menu {
  return {
    ...menu,
    categories: menu.categories.map((c) => ({
      ...c,
      dishes: c.dishes.filter((d) => keep.includes(d.dishId)),
    })),
  };
}

const ids = (state: ReturnType<typeof pickerViewState>) => state.options.map((d) => d.dishId);

describe('pickerViewState', () => {
  it('offers every other complete dish and announces nothing before a search', async () => {
    const menu = await loadMenu('demo');
    const state = pickerViewState(menu, [DISH.avocadoToast], '');
    expect(ids(state)).toEqual([
      DISH.eggsBenedict,
      DISH.harvestPowerBowl,
      DISH.salmonPokeBowl,
      DISH.gardenAvocadoSalad,
    ]);
    expect(state).toMatchObject({
      noOptions: false,
      noResults: false,
      allergyNotice: false,
      announcement: '',
    });
  });

  it('excludes both shown dishes when replacing one side', async () => {
    const menu = await loadMenu('demo');
    const state = pickerViewState(menu, [DISH.avocadoToast, DISH.eggsBenedict], '');
    expect(ids(state)).not.toContain(DISH.avocadoToast);
    expect(ids(state)).not.toContain(DISH.eggsBenedict);
  });

  it('searches by name, category and ingredient with the shared menu rules', async () => {
    const menu = await loadMenu('demo');
    const exclude = [DISH.avocadoToast];
    expect(ids(pickerViewState(menu, exclude, 'benedict'))).toEqual([DISH.eggsBenedict]);
    expect(ids(pickerViewState(menu, exclude, 'salads'))).toEqual([DISH.gardenAvocadoSalad]);
    // Avocado is an ingredient of the kept dish too, which stays out of the options.
    expect(ids(pickerViewState(menu, exclude, 'avocado'))).toEqual([
      DISH.harvestPowerBowl,
      DISH.gardenAvocadoSalad,
    ]);
    expect(pickerViewState(menu, exclude, 'avocado').announcement).toBe('2 dishes found');
    expect(pickerViewState(menu, exclude, 'benedict').announcement).toBe('1 dish found');
  });

  it('shows the staff line for "gluten" and "gluten-free", with no results only for gluten', async () => {
    const menu = await loadMenu('demo');
    const gluten = pickerViewState(menu, [DISH.avocadoToast], 'gluten');
    expect(gluten).toMatchObject({ allergyNotice: true, noResults: true });
    const glutenFree = pickerViewState(menu, [DISH.avocadoToast], 'gluten-free');
    expect(glutenFree.allergyNotice).toBe(true);
    expect(glutenFree.noResults).toBe(false);
  });

  it('shows no results for an unknown dish', async () => {
    const menu = await loadMenu('demo');
    expect(pickerViewState(menu, [DISH.avocadoToast], 'pizza')).toMatchObject({
      options: [],
      noOptions: false,
      noResults: true,
      announcement: 'No dishes found',
    });
  });

  it('never offers an incomplete dish, even when it matches the search', async () => {
    const menu = await loadMenu('edge-cases');
    for (const query of ['', 'a', 'incomplete']) {
      expect(ids(pickerViewState(menu, [DISH.avocadoToast], query))).not.toContain(DISH.incomplete);
    }
  });

  it('reports no options when the kept dish is the only complete dish', async () => {
    const menu = onlyDishes(await loadMenu('demo'), [DISH.avocadoToast]);
    expect(pickerViewState(menu, [DISH.avocadoToast], '')).toMatchObject({
      options: [],
      noOptions: true,
      noResults: false,
    });
    // A search on an empty list stays the no-options state, not "No Result Found".
    expect(pickerViewState(menu, [DISH.avocadoToast], 'pizza').noResults).toBe(false);
  });

  it('reports no options for a menu with no dishes', async () => {
    const menu = onlyDishes(await loadMenu('demo'), []);
    expect(pickerViewState(menu, [], '')).toMatchObject({ options: [], noOptions: true });
  });
});

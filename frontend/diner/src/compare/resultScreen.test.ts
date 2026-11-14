import { describe, expect, it } from 'vitest';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import type { Menu } from '../menu/types';
import type { Comparison } from './comparison';
import { compareView } from './resultScreen';

async function loadMenu(scenario: Parameters<typeof createFixtureMenuSource>[0]): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

const pair = (firstDishId: string, otherDishId: string): Comparison => ({
  comparisonId: 'c0000000-0000-4000-8000-000000000001',
  firstDishId,
  otherDishId,
});

describe('compareView', () => {
  it('returns the kept dish first and the picked dish second, with ingredient names', async () => {
    const menu = await loadMenu('demo');
    const view = compareView(menu, pair(DISH.avocadoToast, DISH.harvestPowerBowl));
    expect(view?.map((side) => [side.side, side.dish.name])).toEqual([
      ['first', 'Avocado Toast'],
      ['other', 'Harvest Power Bowl'],
    ]);
    expect(view?.[1].ingredientNames).toEqual([
      'Quinoa',
      'Grilled chicken',
      'Sweet potato',
      'Avocado',
      'Kale',
    ]);
  });

  it('shows nothing for an empty group, so a dish with no allergens has no Contains row', async () => {
    const menu = await loadMenu('demo');
    const [first, other] = compareView(menu, pair(DISH.avocadoToast, DISH.harvestPowerBowl)) ?? [];
    expect(first).toMatchObject({ hasAllergens: true, hasDietary: true });
    expect(other).toMatchObject({ hasAllergens: false, hasDietary: true });
    const benedict = compareView(menu, pair(DISH.eggsBenedict, DISH.avocadoToast))?.[0];
    expect(benedict).toMatchObject({ hasAllergens: true, hasDietary: false });
  });

  it('uses the detail chip rules: Wheat suppresses Gluten-free', async () => {
    const menu = await loadMenu('edge-cases');
    const pancakes = compareView(menu, pair(DISH.berryPancakeStack, DISH.avocadoToast))?.[0];
    expect(pancakes?.dish.dietary).toEqual(['Vegetarian']);
  });

  it('cannot show the same dish twice, a missing dish or an incomplete dish', async () => {
    const menu = await loadMenu('edge-cases');
    expect(compareView(menu, pair(DISH.avocadoToast, DISH.avocadoToast))).toBeNull();
    expect(compareView(menu, pair(DISH.avocadoToast, DISH.incomplete))).toBeNull();
    expect(compareView(menu, pair('missing', DISH.avocadoToast))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import type { Menu } from '../menu/types';
import type { Comparison } from './comparison';
import { compareView, renderCompareResult } from './resultScreen';

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
    expect(view?.[1]?.ingredientNames).toEqual([
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

describe('compare allergen wording', () => {
  const cell = async (allergensConfirmed: boolean) => {
    const menu = await loadMenu('demo');
    for (const category of menu.categories)
      for (const dish of category.dishes)
        if (dish.kind === 'complete' && dish.dishId === DISH.harvestPowerBowl)
          Object.assign(dish, { allergens: [], dietary: [], allergensConfirmed });
    const container = {
      innerHTML: '',
      querySelector: () => null,
      querySelectorAll: () => [],
    } as unknown as HTMLElement;
    renderCompareResult(container, {
      menu,
      comparison: pair(DISH.avocadoToast, DISH.harvestPowerBowl),
      onViewDetails: () => {},
      onReplace: () => {},
      onBackToMenu: () => {},
    } as unknown as Parameters<typeof renderCompareResult>[1]);
    const dietary = container.innerHTML.split('pp-compare__section--dietary')[1] ?? '';
    return dietary.split('data-side="other"')[1]?.split('data-side=')[0] ?? '';
  };

  it('says Allergens not confirmed for a dish whose allergens were never reviewed', async () => {
    const html = await cell(false);
    expect(html).toContain('Allergens not confirmed');
    expect(html).not.toContain('None listed');
  });

  it('keeps None listed for a reviewed dish with nothing listed', async () => {
    const html = await cell(true);
    expect(html).toContain('None listed');
    expect(html).not.toContain('Allergens not confirmed');
  });
});

import { describe, expect, it } from 'vitest';
import { chipKey, completeDishes, toMenu } from './adapter';
import {
  CATEGORY,
  createFixtureMenuSource,
  DISH,
  edgeCaseBundle,
  FIXTURE_PUBLICATION_REVISION_ID,
  NO_ICON_ALLERGEN,
  NO_ICON_INGREDIENT,
} from './fixtures';
import type { CompleteDish, Menu } from './types';

async function loadMenu(scenario: Parameters<typeof createFixtureMenuSource>[0]): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

function findDish(menu: Menu, dishId: string) {
  return menu.categories.flatMap((c) => c.dishes).find((d) => d.dishId === dishId);
}

function complete(menu: Menu, dishId: string): CompleteDish {
  const dish = findDish(menu, dishId);
  if (dish?.kind !== 'complete') throw new Error(`expected ${dishId} to be complete`);
  return dish;
}

describe('fixture menu source', () => {
  it('serves three coherent complete dishes for the demo journey', async () => {
    const menu = await loadMenu('demo');
    expect(menu.source).toBe('fixture');
    expect(menu.publicationRevisionId).toBe(FIXTURE_PUBLICATION_REVISION_ID);
    expect(menu.restaurant.name).toBe('Ember & Stone');
    expect(completeDishes(menu).map((d) => d.name)).toEqual([
      'Avocado Toast',
      'Classic Eggs Benedict',
      'Harvest Power Bowl',
    ]);
  });

  it('keeps an ingredient match available for the Figma "Avocado" search result', async () => {
    const menu = await loadMenu('demo');
    const bowl = complete(menu, DISH.harvestPowerBowl);
    expect(bowl.ingredients.map((i) => i.name)).toContain('Avocado');
    expect(bowl.categoryName).toBe('Brunch Bowls');
  });

  it('turns a dish marked incomplete into an id-only placeholder', async () => {
    const menu = await loadMenu('edge-cases');
    expect(findDish(menu, DISH.incomplete)).toEqual({
      kind: 'incomplete',
      dishId: DISH.incomplete,
      dishRevisionId: expect.any(String),
      categoryId: CATEGORY.brunchBowls,
    });
  });

  it('treats a dish with an empty ingredient list as an incomplete placeholder', async () => {
    const dish = findDish(await loadMenu('edge-cases'), DISH.noIngredients);
    expect(dish?.kind).toBe('incomplete');
    expect(dish).not.toHaveProperty('name');
    expect(dish).not.toHaveProperty('price');
  });

  it('suppresses Gluten-free when the dish also contains Gluten', async () => {
    const dish = complete(await loadMenu('edge-cases'), DISH.berryPancakeStack);
    expect(dish.allergens).toContain('Gluten');
    expect(dish.dietary).toEqual(['Vegetarian']);
  });

  it('keeps every validated allergen, including one without an icon', async () => {
    const dish = complete(await loadMenu('edge-cases'), DISH.gardenAvocadoSalad);
    expect(dish.allergens).toHaveLength(6);
    expect(dish.allergens).toContain(NO_ICON_ALLERGEN);
    expect(dish.dietary).toEqual(['Vegan', 'Vegetarian', 'Gluten-free']);
  });

  it('includes an ingredient that has no matching icon', async () => {
    const dish = complete(await loadMenu('edge-cases'), DISH.eggsBenedict);
    expect(dish.ingredients.map((i) => i.name)).toContain(NO_ICON_INGREDIENT);
  });

  it('covers a missing image and a long name', async () => {
    const menu = await loadMenu('edge-cases');
    expect(complete(menu, DISH.briocheFrenchToast).images).toBeNull();
    expect(complete(menu, DISH.longName).name.length).toBeGreaterThan(80);
  });

  it('labels every placeholder image as synthetic', async () => {
    for (const dish of completeDishes(await loadMenu('edge-cases'))) {
      if (!dish.images) continue;
      expect(dish.images.card.alt).toMatch(/synthetic fixture/);
      expect(dish.images.card.url).toMatch(/^data:image\/svg\+xml,/);
    }
  });

  it('removes a withdrawn dish on the next load instead of marking it unavailable', async () => {
    const source = createFixtureMenuSource('withdrawal');
    const first = await source.load();
    const second = await source.load();
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('expected menus');
    expect(findDish(first.menu, DISH.salmonPokeBowl)).toBeDefined();
    expect(findDish(second.menu, DISH.salmonPokeBowl)).toBeUndefined();
    expect(second.menu.menuRevisionId).not.toBe(first.menu.menuRevisionId);
  });

  it('provides a separate twenty-dish layout set', async () => {
    expect(completeDishes(await loadMenu('layout-20'))).toHaveLength(20);
  });

  it.each(['empty', 'unavailable', 'error', 'offline'] as const)(
    'reports the %s state without a menu',
    async (scenario) => {
      expect(await createFixtureMenuSource(scenario).load()).toEqual({ status: scenario });
    },
  );

  it('can simulate a slow load and stops when aborted', async () => {
    const controller = new AbortController();
    const pending = createFixtureMenuSource('demo', { delayMs: 10_000 }).load(controller.signal);
    controller.abort(new Error('left the menu'));
    await expect(pending).rejects.toThrow('left the menu');
  });
});

describe('menu adapter', () => {
  it('compares chip labels without case, hyphens or spaces', () => {
    expect(chipKey('Gluten-free')).toBe(chipKey('gluten free'));
    expect(chipKey('Gluten')).not.toBe(chipKey('Gluten-free'));
  });

  it('drops dietary values outside the closed P0 list', () => {
    const result = toMenu(
      {
        ...edgeCaseBundle,
        categories: [
          {
            category_id: CATEGORY.salads,
            name: 'Salads',
            dishes: [
              {
                dish_id: DISH.gardenAvocadoSalad,
                dish_revision_id: DISH.gardenAvocadoSalad,
                complete: true,
                name: 'Test',
                description: 'Test',
                price: { amount: '1.00', currency: 'USD' },
                ingredients: [
                  { ingredient_id: DISH.avocadoToast, name: 'Leaf', description: null },
                ],
                dietary: ['Keto', 'vegan'],
                images: null,
              },
            ],
          },
        ],
      },
      'fixture',
      FIXTURE_PUBLICATION_REVISION_ID,
    );
    if (result.status !== 'ready') throw new Error('expected a ready menu');
    expect(complete(result.menu, DISH.gardenAvocadoSalad).dietary).toEqual(['Vegan']);
    expect(complete(result.menu, DISH.gardenAvocadoSalad).allergens).toEqual([]);
  });
});

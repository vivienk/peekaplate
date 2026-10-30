import { expect, type Page, test } from '@playwright/test';

// S3-DIN-02.1 shared Save state in a real browser: real localStorage, real reloads. No screen uses
// the Save state yet, so the test loads its module from the diner dev server. Menus are the
// labelled S3-DIN-01.1 fixtures; this is fixture evidence, not a live published menu.
const DINER = 'http://127.0.0.1:5173/';

type Scenario = 'edge-cases' | 'after-withdrawal';

// Loads the Save state and a fixture menu in the page, reconciles, and keeps them on window.
async function openSaveState(page: Page, scenario: Scenario, incompleteDish?: string) {
  await page.goto(DINER);
  return page.evaluate(
    async ({ scenario, incompleteDish }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createSaveState } = await load('/src/save/save-state.ts');
      const fixtures = await load('/src/menu/fixtures.ts');
      const { toMenu } = await load('/src/menu/adapter.ts');
      const bundle =
        scenario === 'edge-cases'
          ? fixtures.edgeCaseBundle
          : fixtures.edgeCaseAfterWithdrawalBundle;
      const result = toMenu(bundle, 'fixture', fixtures.FIXTURE_PUBLICATION_REVISION_ID);
      if (result.status !== 'ready') throw new Error(`fixture menu not ready: ${result.status}`);
      let menu = result.menu;
      if (incompleteDish) {
        menu = {
          ...menu,
          categories: menu.categories.map((category: { dishes: { dishId: string }[] }) => ({
            ...category,
            dishes: category.dishes.map((dish: Record<string, unknown>) =>
              dish.dishId === incompleteDish
                ? {
                    kind: 'incomplete',
                    dishId: dish.dishId,
                    dishRevisionId: dish.dishRevisionId,
                    categoryId: dish.categoryId,
                  }
                : dish,
            ),
          })),
        };
      }
      const state = createSaveState({ venueId: menu.venueId });
      const { removed } = state.reconcile(menu);
      Object.assign(window, { saveState: state, DISH: fixtures.DISH });
      return {
        removed,
        venueId: menu.venueId as string,
        dish: fixtures.DISH as Record<string, string>,
      };
    },
    { scenario, incompleteDish },
  );
}

type PageGlobals = {
  saveState: {
    save(id: string): unknown;
    savedDishIds(): string[];
    mode(): string;
    isSaveAvailable(): boolean;
    isSaved(id: string): boolean;
  };
};

const saveState = (page: Page) => ({
  save: (id: string) =>
    page.evaluate((dishId) => (window as unknown as PageGlobals).saveState.save(dishId), id),
  read: () =>
    page.evaluate(() => {
      const state = (window as unknown as PageGlobals).saveState;
      return {
        ids: state.savedDishIds(),
        mode: state.mode(),
        available: state.isSaveAvailable(),
      };
    }),
});

const storedValue = (page: Page, venueId: string) =>
  page.evaluate((key) => window.localStorage.getItem(key), `peekaplate:saved:v1:${venueId}`);

test('saved dishes persist across a real reload, newest first, as dish IDs only', async ({
  page,
}) => {
  const { venueId, dish } = await openSaveState(page, 'edge-cases');
  await saveState(page).save(dish.avocadoToast ?? '');
  await saveState(page).save(dish.harvestPowerBowl ?? '');

  await page.reload();
  await openSaveState(page, 'edge-cases');
  expect(await saveState(page).read()).toEqual({
    ids: [dish.harvestPowerBowl, dish.avocadoToast],
    mode: 'persistent',
    available: true,
  });
  expect(JSON.parse((await storedValue(page, venueId)) ?? 'null')).toEqual({
    version: 1,
    dishIds: [dish.harvestPowerBowl, dish.avocadoToast],
  });
});

test('reloading against an updated menu removes the withdrawn dish and keeps the incomplete one', async ({
  page,
}) => {
  const first = await openSaveState(page, 'edge-cases');
  const { dish } = first;
  await saveState(page).save(dish.salmonPokeBowl ?? '');
  await saveState(page).save(dish.harvestPowerBowl ?? '');

  // The menu update withdraws the Salmon Poke Bowl and leaves the Harvest Power Bowl incomplete.
  await page.reload();
  const updated = await openSaveState(page, 'after-withdrawal', dish.harvestPowerBowl);
  expect(updated.removed).toEqual([dish.salmonPokeBowl]);
  expect((await saveState(page).read()).ids).toEqual([dish.harvestPowerBowl]);

  // The removal was written, so it survives the next reload too.
  await page.reload();
  await openSaveState(page, 'after-withdrawal', dish.harvestPowerBowl);
  expect((await saveState(page).read()).ids).toEqual([dish.harvestPowerBowl]);
});

test('with storage blocked, saving works in memory for the visit and nothing persists', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
  });
  const { dish } = await openSaveState(page, 'edge-cases');
  expect(await saveState(page).save(dish.avocadoToast ?? '')).toEqual({
    changed: true,
    persisted: false,
    savedCount: 1,
  });
  expect(await saveState(page).read()).toEqual({
    ids: [dish.avocadoToast],
    mode: 'session-only',
    available: false,
  });

  await page.reload();
  await openSaveState(page, 'edge-cases');
  expect((await saveState(page).read()).ids).toEqual([]);
});

test('when storage fills up mid-visit, the state switches to session-only and keeps only committed saves', async ({
  page,
}) => {
  const { dish } = await openSaveState(page, 'edge-cases');
  expect(await saveState(page).save(dish.avocadoToast ?? '')).toMatchObject({ persisted: true });

  await page.evaluate(() => {
    window.localStorage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
  });
  expect(await saveState(page).save(dish.harvestPowerBowl ?? '')).toEqual({
    changed: true,
    persisted: false,
    savedCount: 2,
  });
  expect(await saveState(page).read()).toMatchObject({ mode: 'session-only', available: false });

  // The failed write claimed nothing: after a reload only the committed save is there.
  await page.reload();
  await openSaveState(page, 'edge-cases');
  expect((await saveState(page).read()).ids).toEqual([dish.avocadoToast]);
});

test('two restaurants in the same browser keep separate saves', async ({ page }) => {
  const { dish, venueId } = await openSaveState(page, 'edge-cases');
  await saveState(page).save(dish.avocadoToast ?? '');
  const otherKey = `peekaplate:saved:v1:${venueId.replace(/1$/, '2')}`;
  expect(await page.evaluate((key) => window.localStorage.getItem(key), otherKey)).toBeNull();
  expect(await storedValue(page, venueId)).not.toBeNull();
});

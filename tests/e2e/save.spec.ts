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
    unsave(id: string): unknown;
    savedDishIds(): string[];
    mode(): string;
    isSaveAvailable(): boolean;
    isSaved(id: string): boolean;
  };
};

const saveState = (page: Page) => ({
  save: (id: string) =>
    page.evaluate((dishId) => (window as unknown as PageGlobals).saveState.save(dishId), id),
  unsave: (id: string) =>
    page.evaluate((dishId) => (window as unknown as PageGlobals).saveState.unsave(dishId), id),
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

// Adam, 30 Oct: no live sync in P0, but a stale tab must never wipe saves made in another tab.
test('a stale tab never wipes saves made in another tab of the same restaurant', async ({
  context,
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  const { venueId, dish } = await openSaveState(tabA, 'edge-cases');
  await openSaveState(tabB, 'edge-cases');

  // Tab B saves first; tab A has not reloaded, so its list is stale.
  await saveState(tabB).save(dish.avocadoToast ?? '');
  expect(await saveState(tabA).save(dish.harvestPowerBowl ?? '')).toEqual({
    changed: true,
    persisted: true,
    savedCount: 2,
  });
  expect(JSON.parse((await storedValue(tabA, venueId)) ?? 'null').dishIds).toEqual([
    dish.harvestPowerBowl,
    dish.avocadoToast,
  ]);

  // Tab A saving the dish tab B already saved is not reported as tab A's change.
  expect(await saveState(tabA).save(dish.avocadoToast ?? '')).toMatchObject({ changed: false });

  // A stale unsave in tab B removes only its own dish.
  await saveState(tabB).unsave(dish.avocadoToast ?? '');
  expect(JSON.parse((await storedValue(tabB, venueId)) ?? 'null').dishIds).toEqual([
    dish.harvestPowerBowl,
  ]);
});

// S3-DIN-02.2: hearts, badge, Undo and toasts on real elements. The page stands in for the screens:
// two hearts for the same dish (card and detail), the header badge and a toast area.
async function openSaveUi(page: Page) {
  await page.goto(DINER);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createSaveState } = await load('/src/save/save-state.ts');
    const { mountSaveHeart, mountSaveBadge, mountToastArea } = await load('/src/save/mount.ts');
    const fixtures = await load('/src/menu/fixtures.ts');
    const { toMenu } = await load('/src/menu/adapter.ts');
    const result = toMenu(
      fixtures.edgeCaseBundle,
      'fixture',
      fixtures.FIXTURE_PUBLICATION_REVISION_ID,
    );
    const menu = result.menu;
    const dish = menu.categories
      .flatMap((c: { dishes: { dishId: string }[] }) => c.dishes)
      .find((d: { dishId: string }) => d.dishId === fixtures.DISH.avocadoToast);
    const saveState = createSaveState({ venueId: menu.venueId });
    saveState.reconcile(menu);
    document.body.innerHTML = `
      <header><span class="badge" data-testid="badge"></span></header>
      <div class="pp-toast-area" aria-live="polite" aria-atomic="true" data-testid="toasts"></div>
      <button type="button" aria-label="Save Avocado Toast" data-testid="card-heart">♡</button>
      <button type="button" aria-label="Save Avocado Toast" data-testid="detail-heart">♡</button>
      <p data-testid="elsewhere">Elsewhere</p>`;
    const events: [string, Record<string, unknown>][] = [];
    const send = (name: string, payload: Record<string, unknown>) => events.push([name, payload]);
    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
    mountToastArea(q('toasts'), saveState);
    mountSaveBadge(q('badge'), saveState);
    mountSaveHeart(q('card-heart'), { saveState, menu, dish, surface: 'menu_card', send });
    mountSaveHeart(q('detail-heart'), { saveState, menu, dish, surface: 'dish_detail', send });
    Object.assign(window, { saveEvents: events });
  });
}

const sentEvents = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { saveEvents: [string, Record<string, unknown>][] }).saveEvents.map(
      ([name, payload]) => ({ name, ...payload }),
    ),
  );

test('a heart saves and unsaves, and every heart and the badge stay in sync', async ({ page }) => {
  await openSaveUi(page);
  const card = page.getByTestId('card-heart');
  const detail = page.getByTestId('detail-heart');
  const badge = page.getByTestId('badge');
  await expect(card).toHaveAttribute('aria-pressed', 'false');
  await expect(badge).toBeHidden();

  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toHaveAttribute('aria-pressed', 'true');
  await expect(badge).toHaveText('1');
  await expect(badge).toBeVisible();

  await detail.click();
  await expect(card).toHaveAttribute('aria-pressed', 'false');
  await expect(badge).toBeHidden();
  expect((await sentEvents(page)).map((e) => [e.name, e.save_surface ?? e.unsave_surface])).toEqual(
    [
      ['dish_saved', 'menu_card'],
      ['dish_unsaved', 'dish_detail'],
    ],
  );
});

test('unsave shows the removed toast; Undo by keyboard restores the dish and shows the restored toast', async ({
  page,
}) => {
  await openSaveUi(page);
  const card = page.getByTestId('card-heart');
  const toasts = page.getByTestId('toasts');
  await card.click();
  await card.click();
  await expect(toasts).toContainText('Removed from Saved');

  // Tapping elsewhere does not dismiss it.
  await page.getByTestId('elsewhere').click();
  await expect(toasts).toContainText('Removed from Saved');

  const undo = toasts.getByRole('button', { name: 'Undo' });
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(toasts).toContainText('Added back to Saved');
  await expect(toasts.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  const events = await sentEvents(page);
  expect(events.map((e) => [e.name, e.save_origin ?? null])).toEqual([
    ['dish_saved', 'direct'],
    ['dish_unsaved', null],
    ['dish_saved', 'undo'],
  ]);
  await expect(toasts).toHaveAttribute('aria-live', 'polite');
});

test('the removed toast disappears after 5 seconds and the restored toast after 3', async ({
  page,
}) => {
  await page.clock.install();
  await openSaveUi(page);
  const card = page.getByTestId('card-heart');
  const toasts = page.getByTestId('toasts');
  await card.click();
  await card.click();
  await page.clock.runFor(4900);
  await expect(toasts).toContainText('Removed from Saved');
  await page.clock.runFor(200);
  await expect(toasts).toBeEmpty();

  await card.click();
  await card.click();
  await toasts.getByRole('button', { name: 'Undo' }).click();
  await page.clock.runFor(2900);
  await expect(toasts).toContainText('Added back to Saved');
  await page.clock.runFor(200);
  await expect(toasts).toBeEmpty();
});

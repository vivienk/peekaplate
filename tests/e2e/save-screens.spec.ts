import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// S3-DIN-02.2 and .5 on the real DIN-01 screens: card and detail hearts, the header badge, toasts
// with Undo, and the Saved screen behind its route. Menus are the labelled fixtures; in fixture
// mode track() only logs each event to the development console, which these tests read.
const DINER = 'http://127.0.0.1:5173/';
const EDGE = `${DINER}?scenario=edge-cases`;

type Logged = { type: string; payload: Record<string, unknown> };

// Collects the events track() accepted, in order.
function recordEvents(page: Page): Logged[] {
  const events: Logged[] = [];
  page.on('console', async (message) => {
    if (!message.text().startsWith('[track] test event')) return;
    const envelope = (await message.args()[1]?.jsonValue()) as Logged | undefined;
    if (envelope) events.push({ type: envelope.type, payload: envelope.payload });
  });
  return events;
}

const card = (page: Page, name: string) =>
  page.locator('.pp-category:not([hidden]) .pp-card').filter({ hasText: name });
const cardHeart = (page: Page, name: string) =>
  card(page, name).getByRole('button', { name: `Save ${name}` });
const headerButton = (page: Page) => page.getByRole('button', { name: /^Saved dishes/ });
const badge = (page: Page) => page.locator('.pp-saved__badge');
// One toast shows at a time, in whichever screen's area is on the page.
const toasts = (page: Page) => page.locator('.pp-toast');

test('a card heart saves the dish, and the badge, detail heart and header agree', async ({
  page,
}) => {
  const events = recordEvents(page);
  await page.goto(DINER);
  const heart = cardHeart(page, 'Avocado Toast');
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await expect(badge(page)).toBeHidden();
  await expect(headerButton(page)).toHaveAccessibleName('Saved dishes');

  const heartIcon = heart.locator('.pp-save-heart__icon img');
  const unsavedSrc = await heartIcon.getAttribute('src');
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  // The outline heart becomes the filled heart: a different image.
  await expect(heartIcon).not.toHaveAttribute('src', unsavedSrc ?? '');
  // Figma's Heart with Text: "Save" becomes "Saved" once saved (review #13); the name stays.
  await expect(heart).toContainText('Saved');
  await expect(heart).toHaveAccessibleName('Save Avocado Toast');
  await expect(badge(page)).toHaveText('1');
  await expect(headerButton(page)).toHaveAccessibleName('Saved dishes, 1');
  // The count sits on the heart's top-right edge, as in Figma, not over its centre (Adam, 9 Nov).
  const box = async (selector: string) => {
    const found = await page.locator(selector).boundingBox();
    if (!found) throw new Error(`${selector} has no box`);
    return found;
  };
  const icon = await box('.pp-saved__icon');
  const count = await box('.pp-saved__badge');
  expect(count.x + count.width / 2).toBeGreaterThan(icon.x + icon.width * 0.7);
  expect(count.y + count.height / 2).toBeLessThan(icon.y + icon.height * 0.4);
  // Saving is quiet: only removing shows a toast.
  await expect(page.locator('.pp-toast')).toHaveCount(0);

  // Tapping the heart does not open the dish.
  await expect(page.getByRole('heading', { name: 'Dish details' })).toHaveCount(0);

  await card(page, 'Avocado Toast').getByRole('button', { name: 'Open Avocado Toast' }).click();
  await expect(page.getByRole('heading', { name: 'Dish details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Avocado Toast' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText('View Portion and Compare are not available yet.')).toBeVisible();

  await expect
    .poll(() => events.filter((e) => e.type === 'dish_saved').map((e) => e.payload.save_surface))
    .toEqual(['menu_card']);
});

test('hearts keep working on the cards search leaves visible (#121)', async ({ page }) => {
  await page.goto(DINER);
  await page.getByRole('button', { name: 'Search menu' }).click();
  await page.getByRole('searchbox', { name: 'Search dishes or ingredients' }).fill('benedict');
  const heart = cardHeart(page, 'Classic Eggs Benedict');
  await expect(heart).toBeVisible();
  await expect(cardHeart(page, 'Avocado Toast')).toBeHidden();
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(badge(page)).toHaveText('1');
});

test('removing a dish on the detail shows Undo, and Undo restores it everywhere', async ({
  page,
}) => {
  const events = recordEvents(page);
  await page.goto(DINER);
  await cardHeart(page, 'Avocado Toast').click();
  await card(page, 'Avocado Toast').getByRole('button', { name: 'Open Avocado Toast' }).click();

  const detailHeart = page.getByRole('button', { name: 'Save Avocado Toast' });
  await detailHeart.click();
  await expect(detailHeart).toHaveAttribute('aria-pressed', 'false');
  await expect(detailHeart).toHaveText('Save');
  await expect(toasts(page)).toContainText('Removed from saved dishes');
  // The toast sits at the top, directly below the header, and covers none of it (review #2).
  const header = await page.locator('.pp-detail__topbar').boundingBox();
  const toast = await page.locator('.pp-toast').boundingBox();
  if (!header || !toast) throw new Error('header or toast has no box');
  expect(toast.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(toast.y).toBeLessThanOrEqual(header.y + header.height + 16);

  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await expect(detailHeart).toHaveAttribute('aria-pressed', 'true');
  await expect(toasts(page)).toContainText('Added back to Saved');

  await page.getByRole('button', { name: 'Back to menu' }).click();
  await expect(cardHeart(page, 'Avocado Toast')).toHaveAttribute('aria-pressed', 'true');
  await expect(badge(page)).toHaveText('1');

  await expect
    .poll(() =>
      events
        .filter((e) => e.type === 'dish_saved' || e.type === 'dish_unsaved')
        .map((e) => [
          e.type,
          e.payload.save_surface ?? e.payload.unsave_surface,
          e.payload.save_origin ?? null,
        ]),
    )
    .toEqual([
      ['dish_saved', 'menu_card', 'direct'],
      ['dish_unsaved', 'dish_detail', null],
      ['dish_saved', 'dish_detail', 'undo'],
    ]);
});

test('a toast that is showing follows the diner back to the menu', async ({ page }) => {
  await page.goto(DINER);
  await cardHeart(page, 'Avocado Toast').click();
  await card(page, 'Avocado Toast').getByRole('button', { name: 'Open Avocado Toast' }).click();
  await page.getByRole('button', { name: 'Save Avocado Toast' }).click();
  await page.getByRole('button', { name: 'Back to menu' }).click();
  await expect(toasts(page)).toContainText('Removed from saved dishes');
  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await expect(cardHeart(page, 'Avocado Toast')).toHaveAttribute('aria-pressed', 'true');
});

test('the header heart opens the Saved screen on its own route, and Back returns to the menu', async ({
  page,
}) => {
  const events = recordEvents(page);
  await page.goto(EDGE);
  await cardHeart(page, 'Avocado Toast').click();
  await cardHeart(page, 'Brioche French Toast').click();

  await headerButton(page).click();
  await expect(page).toHaveURL(/\?scenario=edge-cases#saved$/);
  await expect(page.getByRole('heading', { name: 'Saved Dishes' })).toBeFocused();
  const items = page.locator('.pp-saved__item');
  await expect(items).toHaveCount(2);
  // Newest first, with #69's price formatter and image fallback.
  await expect(items.nth(0)).toContainText('Brioche French Toast');
  await expect(items.nth(0)).toContainText('$16.00');
  await expect(items.nth(0).locator('.pp-card__image--missing')).toHaveCount(1);
  await expect(items.nth(1)).toContainText('Avocado Toast');
  await expect(items.nth(1).locator('img.pp-saved__image')).toHaveCount(1);

  await page.getByRole('button', { name: 'Back to menu' }).click();
  await expect(page).toHaveURL(/\?scenario=edge-cases$/);
  await expect(headerButton(page)).toBeFocused();

  // The screen's Back stepped back in history, so the browser's Forward and Back buttons follow
  // the same route.
  await page.goForward();
  await expect(page).toHaveURL(/#saved$/);
  await expect(page.getByRole('heading', { name: 'Saved Dishes' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\?scenario=edge-cases$/);
  await expect(page.getByRole('navigation', { name: 'Menu categories' })).toBeVisible();

  await expect
    .poll(() => events.filter((e) => e.type === 'shortlist_viewed').map((e) => e.payload))
    .toEqual([
      expect.objectContaining({ shortlist_size: 2 }),
      expect.objectContaining({ shortlist_size: 2 }),
    ]);
});

test('a saved dish opens its detail with source saved_screen, and Back returns to Saved', async ({
  page,
}) => {
  const events = recordEvents(page);
  await page.goto(DINER);
  await cardHeart(page, 'Harvest Power Bowl').click();
  await headerButton(page).click();
  await page.locator('.pp-saved__open').click();

  await expect(page.getByRole('heading', { name: 'Dish details' })).toBeVisible();
  await expect(page.locator('.pp-detail__name')).toHaveText('Harvest Power Bowl');
  await expect
    .poll(() => events.filter((e) => e.type === 'dish_detail_opened').map((e) => e.payload))
    .toEqual([expect.objectContaining({ source: 'saved_screen', save_available: true })]);

  await page.getByRole('button', { name: 'Back to Saved' }).click();
  await expect(page.getByRole('heading', { name: 'Saved Dishes' })).toBeVisible();
  await expect(page.locator('.pp-saved__item')).toHaveCount(1);
});

test('a reload on the Saved route opens the Saved screen, and leaving it replaces the route', async ({
  page,
}) => {
  await page.goto(DINER);
  await cardHeart(page, 'Avocado Toast').click();
  await headerButton(page).click();
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Saved Dishes' })).toBeVisible();
  await expect(page.locator('.pp-saved__item')).toContainText('Avocado Toast');
  await page.getByRole('button', { name: 'Back to menu' }).click();
  await expect(page).toHaveURL(DINER);
  await expect(cardHeart(page, 'Avocado Toast')).toHaveAttribute('aria-pressed', 'true');
});

test('when storage is blocked, Save works for the visit and sends no Save events', async ({
  page,
}) => {
  const events = recordEvents(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
  });
  await page.goto(DINER);
  await cardHeart(page, 'Avocado Toast').click();
  await expect(badge(page)).toHaveText('1');
  await headerButton(page).click();
  await expect(page.getByText('Saved for this session only')).toBeVisible();
  await expect(page.locator('.pp-saved__item')).toHaveCount(1);
  expect(events.filter((e) => e.type.startsWith('dish_') || e.type === 'shortlist_viewed')).toEqual(
    [],
  );
});

test('Save controls work by keyboard and the screens pass an accessibility scan', async ({
  page,
}) => {
  await page.goto(DINER);
  const heart = cardHeart(page, 'Avocado Toast');
  await heart.focus();
  await page.keyboard.press('Enter');
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await expect(toasts(page).getByRole('button', { name: 'Undo' })).toBeVisible();

  const scan = async (skip: string[] = []) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .disableRules(skip)
      .analyze();
    return violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) }));
  };
  // The menu with a removed toast showing. Figma places the toast over the content under the
  // header, so while it shows it covers part of a category tab; target-size reports that overlap.
  // Rania's review #25 checks this placement; the rest of the scan still runs.
  expect(await scan(['target-size'])).toEqual([]);

  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await headerButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Saved Dishes' })).toBeFocused();
  expect(await scan()).toEqual([]);
});

// Live menu swaps (#85). Same synthetic source seam as published-refresh.spec.ts: the real
// rendering and refresher, with a fixture menu standing in for the published one.
async function openLiveMenu(page: Page) {
  await page.route('**/src/menu/menuScreen.ts*', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replaceAll('import.meta.env.VITE_MENU_SOURCE', '"live"')
      .replaceAll('import.meta.env.VITE_PUBLIC_API_URL', '"http://127.0.0.1:5173"');
    await route.fulfill({ response, body });
  });
  await page.route('**/src/menu/published.ts*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `import { createFixtureMenuSource } from '/src/menu/fixtures.ts';
        export function createPublishedMenuSource(options) {
          let revision = 0;
          return { async load() {
            const result = await createFixtureMenuSource('demo').load();
            const menu = { ...result.menu, source: 'published', notice: null,
              publicationRevisionId: 'synthetic-publication-' + revision++ };
            if (window.removeDish) menu.categories = menu.categories.map(category => ({
              ...category, dishes: category.dishes.filter(dish => dish.dishId !== window.removeDish)
            }));
            if (window.renameDish) menu.categories = menu.categories.map(category => ({
              ...category, dishes: category.dishes.map(dish => dish.dishId === window.renameDish
                ? { ...dish, name: 'Updated Avocado Toast', dishRevisionId: 'updated-dish-revision' } : dish)
            }));
            options.onDelivery({ token: 'synthetic-only', expiresAt: Date.now() + 1800000,
              publicationId: menu.publicationRevisionId });
            return { status: 'ready', menu };
          }};
        }`,
    }),
  );
  await page.route('**/src/menu/refresh.ts*', async (route) => {
    if (route.request().url().includes('original')) return route.continue();
    await route.fulfill({
      contentType: 'text/javascript',
      body: `import { createMenuRefresher as create } from '/src/menu/refresh.ts?original';
        export function createMenuRefresher(options) {
          const refresher = create(options);
          window.refreshMenu = () => refresher.refresh();
          return refresher;
        }`,
    });
  });
  await page.goto(
    'http://127.0.0.1:5173/venues/00000000-0000-4000-8000-000000000001/menus/00000000-0000-4000-8000-000000000002',
  );
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
}

async function swapPublication(page: Page) {
  await page.evaluate(() => (window as unknown as { refreshMenu(): Promise<void> }).refreshMenu());
}

test('Saved uses the refreshed dish revision before opening its detail', async ({ page }) => {
  await openLiveMenu(page);
  const heart = cardHeart(page, 'Avocado Toast');
  const dishId = await heart.getAttribute('data-save-dish-id');
  await heart.click();
  await headerButton(page).click();
  await expect(page.locator('.pp-saved__item')).toContainText('Avocado Toast');
  await page.evaluate((id) => {
    (window as unknown as { renameDish: string | null }).renameDish = id;
  }, dishId);
  await swapPublication(page);
  await expect(page.locator('.pp-saved__item')).toContainText('Updated Avocado Toast');
  await page.locator('.pp-saved__open').click();
  await expect(page.locator('.pp-detail')).toContainText('Updated Avocado Toast');
});

test('keyboard removal in Saved keeps focus on the next action and the empty-state button', async ({
  page,
}) => {
  await page.goto(DINER);
  await cardHeart(page, 'Avocado Toast').click();
  await cardHeart(page, 'Classic Eggs Benedict').click();
  await headerButton(page).click();
  const hearts = page.locator('.pp-saved__save');
  await hearts.first().focus();
  await page.keyboard.press('Enter');
  await expect(hearts).toHaveCount(1);
  await expect(hearts.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Browse menu' })).toBeFocused();
  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await expect(hearts).toHaveCount(1);
});

test('a new publication keeps Save working: focus, hearts, badge, and withdrawn dishes drop out', async ({
  page,
}) => {
  await openLiveMenu(page);
  const avocado = cardHeart(page, 'Avocado Toast');
  await avocado.click();
  await expect(badge(page)).toHaveText('1');
  await avocado.focus();

  await swapPublication(page);
  await expect(avocado).toHaveAttribute('aria-pressed', 'true');
  await expect(avocado).toBeFocused();
  await expect(badge(page)).toHaveText('1');
  // The redrawn hearts and header are attached again.
  await cardHeart(page, 'Classic Eggs Benedict').click();
  await expect(badge(page)).toHaveText('2');

  // The next publication withdraws a saved dish: it leaves Saved without a toast.
  const dishId = await avocado.getAttribute('data-save-dish-id');
  await page.evaluate((id) => {
    (window as unknown as { removeDish: string | null }).removeDish = id;
  }, dishId);
  await swapPublication(page);
  await expect(badge(page)).toHaveText('1');
  await expect(page.locator('.pp-toast')).toHaveCount(0);
  await headerButton(page).click();
  await expect(page.locator('.pp-saved__item')).toHaveCount(1);
  await expect(page.locator('.pp-saved__item')).toContainText('Classic Eggs Benedict');
});

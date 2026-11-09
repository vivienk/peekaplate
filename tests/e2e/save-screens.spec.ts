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
const toasts = (page: Page) => page.locator('.pp-toast-area:visible');

test('a card heart saves the dish, and the badge, detail heart and header agree', async ({
  page,
}) => {
  const events = recordEvents(page);
  await page.goto(DINER);
  const heart = cardHeart(page, 'Avocado Toast');
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await expect(badge(page)).toBeHidden();
  await expect(headerButton(page)).toHaveAccessibleName('Saved dishes');

  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(heart.locator('.pp-save-heart__icon')).toHaveText('♥');
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
  await expect(toasts(page)).toContainText('Removed from Saved');

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
  await expect(toasts(page)).toContainText('Removed from Saved');
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
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeFocused();
  const items = page.locator('.pp-saved__item');
  await expect(items).toHaveCount(2);
  // Newest first, with #69's price formatter and image fallback.
  await expect(items.nth(0)).toContainText('Brioche French Toast');
  await expect(items.nth(0)).toContainText('$16.00');
  await expect(items.nth(0).locator('.pp-card__image--missing')).toHaveCount(1);
  await expect(items.nth(1)).toContainText('Avocado Toast');
  await expect(items.nth(1).locator('img')).toHaveCount(1);

  await page.getByRole('button', { name: 'Back to menu' }).click();
  await expect(page).toHaveURL(/\?scenario=edge-cases$/);
  await expect(headerButton(page)).toBeFocused();

  // The screen's Back stepped back in history, so the browser's Forward and Back buttons follow
  // the same route.
  await page.goForward();
  await expect(page).toHaveURL(/#saved$/);
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
  await expect(page.locator('.pp-saved__item')).toHaveCount(1);
});

test('a reload on the Saved route opens the Saved screen, and leaving it replaces the route', async ({
  page,
}) => {
  await page.goto(DINER);
  await cardHeart(page, 'Avocado Toast').click();
  await headerButton(page).click();
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
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

  const scan = async () => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    return violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) }));
  };
  // The menu with a removed toast showing.
  expect(await scan()).toEqual([]);

  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await headerButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeFocused();
  expect(await scan()).toEqual([]);
});

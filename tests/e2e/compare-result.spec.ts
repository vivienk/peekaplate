// S3-DIN-02.4 Compare result, Replace and dish_compared on synthetic fixtures (Figma "Compare
// result allergens"). Events are read from the fixture-mode console log: nothing is sent.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

type LoggedEvent = { type: string; payload: Record<string, unknown> };

// Collects fixture-mode test events ("[track] test event (fixture mode, not sent)", envelope).
function captureEvents(page: Page): LoggedEvent[] {
  const events: LoggedEvent[] = [];
  page.on('console', async (message) => {
    if (!message.text().includes('[track] test event')) return;
    const envelope = (await message.args()[1]?.jsonValue()) as LoggedEvent | undefined;
    if (envelope) events.push({ type: envelope.type, payload: envelope.payload });
  });
  return events;
}

const compared = (events: LoggedEvent[]) => events.filter((e) => e.type === 'dish_compared');

async function openDetail(page: Page, dishName: string, scenario = 'demo') {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:5173/?scenario=${scenario}`);
  await page
    .getByRole('button', { name: `Open ${dishName}` })
    .first()
    .click();
  await expect(page.locator('.pp-detail')).toBeVisible();
}

async function compare(page: Page, keptName: string, pickedName: string, scenario = 'demo') {
  await openDetail(page, keptName, scenario);
  await page.locator('.pp-detail__compare').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Compare Dish' })).toBeVisible();
  await page.getByRole('button', { name: `Compare with ${pickedName}` }).click();
  await page.locator('.pp-picker__confirm').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Compare', exact: true })).toBeVisible();
}

const sideNames = (page: Page) => page.locator('.pp-compare__name');

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((n) => n.target),
    })),
  ).toEqual([]);
}

test('confirming a pick shows both dishes side by side and fires dish_compared start', async ({
  page,
}) => {
  const events = captureEvents(page);
  await compare(page, 'Avocado Toast', 'Harvest Power Bowl');

  await expect(sideNames(page)).toHaveText(['Avocado Toast', 'Harvest Power Bowl']);
  // Like the menu, the result starts at the top and fills the 390px frame (Adam, PR #127).
  const box = await page.locator('.pp-compare').boundingBox();
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(390);
  // Every header, section and action cell carries data-side, so a side is all of its cells.
  const first = page.locator('[data-side="first"]');
  const other = page.locator('[data-side="other"]');
  await expect(first.locator('.pp-compare__price')).toHaveText('$14.00');
  await expect(other.locator('.pp-compare__price')).toHaveText('$18.00');
  await expect(first.locator('.pp-compare__description')).toContainText('Smashed avocado');
  await expect(other.locator('.pp-compare__ingredient-names')).toHaveText(
    'Quinoa, Grilled chicken, Sweet potato, Avocado, Kale',
  );
  // One divider in the header, each section and the action row.
  await expect(page.locator('.pp-compare__divider').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'View details of Avocado Toast' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace Harvest Power Bowl' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Menu' })).toBeVisible();

  // Figma structure (Azoz review #11): Description, Key ingredients (with the buttons at its foot)
  // and one Dietary & Allergen Info section drawn with the approved icons.
  for (const heading of ['Description', 'Key ingredients', 'Dietary & Allergen Info']) {
    await expect(page.getByRole('heading', { level: 3, name: heading })).toBeVisible();
  }
  await expect(page.getByRole('heading', { level: 3, name: 'Contains' })).toHaveCount(0);
  await expect(page.locator('.pp-compare__section--ingredients .pp-compare__view')).toHaveCount(2);
  await expect(first.getByRole('img', { name: 'Contains Wheat' })).toBeVisible();
  await expect(first.getByRole('img', { name: 'Contains Eggs' })).toBeVisible();
  await expect(first.getByRole('img', { name: 'Vegetarian' })).toBeVisible();
  await expect(other.getByRole('img', { name: /^Contains/ })).toHaveCount(0);
  // Figma buttons: outlined "View details →" and a text-style Replace.
  await expect(first.locator('.pp-compare__view')).toHaveClass(/pp-btn--outlined/);
  await expect(first.locator('.pp-compare__replace')).not.toHaveClass(/pp-btn/);
  await expect(other.getByRole('img', { name: 'Gluten-free' })).toBeVisible();
  await expect(
    page.getByText('For allergy questions, please ask the restaurant staff.'),
  ).toBeVisible();

  await expect.poll(() => compared(events).length).toBe(1);
  const [start] = compared(events);
  expect(start?.payload).toMatchObject({
    compare_action: 'start',
    dish_id: 'a1000000-0000-4000-8000-000000000001',
    other_dish_id: 'a1000000-0000-4000-8000-000000000002',
    // Save is wired now (#122), and storage works in this browser.
    save_available: true,
  });
  expect(start?.payload.comparison_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(start?.payload.dish_revision_id).not.toBe(start?.payload.other_dish_revision_id);
  // Opening and using the picker fired nothing before the result was shown. The menu and detail
  // events before it are DIN-01's own (menu_viewed, dish_viewed, the opening and its checkpoint).
  const din01 = new Set([
    'menu_viewed',
    'dish_viewed',
    'dish_detail_opened',
    'dish_activity_checkpoint',
  ]);
  expect(events.map((e) => e.type).filter((type) => !din01.has(type))).toEqual(['dish_compared']);

  await page.screenshot({ path: 'test-results/compare-result-fixture.png', fullPage: true });
  await expectNoAxeViolations(page);
});

test('Replace then replace again keeps the comparison_id and fires replace each time', async ({
  page,
}) => {
  const events = captureEvents(page);
  await compare(page, 'Avocado Toast', 'Harvest Power Bowl');

  // Replace the second dish: Avocado Toast is kept and neither shown dish is offered.
  await page.getByRole('button', { name: 'Replace Harvest Power Bowl' }).click();
  await expect(page.locator('.pp-picker__kept-name')).toHaveText('Avocado Toast');
  const confirm = page.locator('.pp-picker__confirm');
  await expect(confirm).toHaveText('Replace Dish');
  await expect(confirm).toBeDisabled();
  await expect(page.locator('.pp-picker__option .pp-card__name-text')).toHaveText([
    'Classic Eggs Benedict',
    'Salmon Poke Bowl',
    'Garden Avocado Salad',
  ]);
  await page.getByRole('button', { name: 'Compare with Salmon Poke Bowl' }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(sideNames(page)).toHaveText(['Avocado Toast', 'Salmon Poke Bowl']);
  await expect(page.getByRole('button', { name: 'Replace Salmon Poke Bowl' })).toBeFocused();

  // Replace the first dish: Salmon Poke Bowl is now the one kept.
  await page.getByRole('button', { name: 'Replace Avocado Toast' }).click();
  await expect(page.locator('.pp-picker__kept-name')).toHaveText('Salmon Poke Bowl');
  await page.getByRole('button', { name: 'Compare with Classic Eggs Benedict' }).click();
  await page.locator('.pp-picker__confirm').click();
  await expect(sideNames(page)).toHaveText(['Classic Eggs Benedict', 'Salmon Poke Bowl']);

  await expect.poll(() => compared(events).length).toBe(3);
  const [start, replaceOther, replaceFirst] = compared(events);
  expect(compared(events).map((e) => e.payload.compare_action)).toEqual([
    'start',
    'replace',
    'replace',
  ]);
  expect(replaceOther?.payload.comparison_id).toBe(start?.payload.comparison_id);
  expect(replaceFirst?.payload.comparison_id).toBe(start?.payload.comparison_id);
  expect(replaceOther?.payload).toMatchObject({
    dish_id: 'a1000000-0000-4000-8000-000000000001',
    other_dish_id: 'a1000000-0000-4000-8000-000000000006',
  });
  expect(replaceFirst?.payload).toMatchObject({
    dish_id: 'a1000000-0000-4000-8000-000000000003',
    other_dish_id: 'a1000000-0000-4000-8000-000000000006',
  });
});

test('cancelling Replace returns to the same result and fires nothing', async ({ page }) => {
  const events = captureEvents(page);
  await compare(page, 'Avocado Toast', 'Harvest Power Bowl');
  await expect.poll(() => compared(events).length).toBe(1);

  await page.getByRole('button', { name: 'Replace Avocado Toast' }).click();
  await page.getByRole('button', { name: 'Compare with Salmon Poke Bowl' }).click();
  await page.getByRole('button', { name: 'Close compare' }).click();
  await expect(sideNames(page)).toHaveText(['Avocado Toast', 'Harvest Power Bowl']);
  await expect(page.getByRole('button', { name: 'Replace Avocado Toast' })).toBeFocused();

  await page.getByRole('button', { name: 'Replace Avocado Toast' }).click();
  await page.keyboard.press('Escape');
  await expect(sideNames(page)).toHaveText(['Avocado Toast', 'Harvest Power Bowl']);

  await page.waitForTimeout(200);
  expect(compared(events)).toHaveLength(1);
});

test('View details opens the dish detail from compare_view and Back returns to the result', async ({
  page,
}) => {
  const events = captureEvents(page);
  await compare(page, 'Avocado Toast', 'Harvest Power Bowl');
  await expect.poll(() => compared(events).length).toBe(1);

  const view = page.getByRole('button', { name: 'View details of Harvest Power Bowl' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  await view.click();
  await expect(page.getByRole('heading', { level: 2, name: 'Harvest Power Bowl' })).toBeVisible();
  // There is no Compare or Replace on a detail opened from a comparison.
  await expect(page.locator('.pp-detail__compare')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Replace/ })).toHaveCount(0);

  // The first detail (opened from the menu card) has its own DIN-01 opening; only the
  // compare_view one comes from Compare.
  const fromCompare = () =>
    events.filter((e) => e.type === 'dish_detail_opened' && e.payload.source === 'compare_view');
  await expect.poll(() => fromCompare().length).toBe(1);
  expect(fromCompare()[0]?.payload).toMatchObject({
    dish_id: 'a1000000-0000-4000-8000-000000000002',
    source: 'compare_view',
    nav_relation: 'from_compare',
  });

  await page.getByRole('button', { name: 'Back to compare' }).click();
  await expect(sideNames(page)).toHaveText(['Avocado Toast', 'Harvest Power Bowl']);
  await expect(view).toBeFocused();
  // Azoz review #13: the result comes back where the diner left it, with the button on screen.
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  await expect(view).toBeInViewport();
  await page.waitForTimeout(200);
  // Coming back shows the same comparison again; it is not a new start.
  expect(compared(events)).toHaveLength(1);
});

test('Back to Menu, close and Escape leave Compare for the menu', async ({ page }) => {
  for (const leave of ['Back to Menu', 'Close compare', 'Escape'] as const) {
    await compare(page, 'Avocado Toast', 'Harvest Power Bowl');
    if (leave === 'Escape') await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: leave }).click();
    await expect(page.getByRole('button', { name: 'Open Avocado Toast' }).first()).toBeFocused();
  }
});

test('allergen and dietary rows line up across the two dishes, with no horizontal scroll', async ({
  page,
}) => {
  // Many wrapping chips (Garden Avocado Salad) next to a dish with no allergens.
  await compare(page, 'Harvest Power Bowl', 'Garden Avocado Salad');
  const top = (side: 'first' | 'other', part: string) =>
    page
      .locator(
        `[data-side="${side}"].pp-compare__${part}, [data-side="${side}"] .pp-compare__${part}`,
      )
      .evaluate((el) => el.getBoundingClientRect().top);
  for (const part of ['name', 'price', 'ingredient-names', 'icons', 'actions']) {
    expect(await top('first', part)).toBeCloseTo(await top('other', part), 0);
  }
  const salad = page.locator('[data-side="other"]');
  await expect(salad.locator('.pp-chip__text', { hasText: 'Mustard' })).toBeVisible();
  const chipTops = await salad
    .locator('.pp-compare__icons > li')
    .evaluateAll(
      (chips) => new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size,
    );
  expect(chipTops).toBeGreaterThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: 'test-results/compare-result-alignment-fixture.png',
    fullPage: true,
  });
});

// Azoz review #12: a dish with no dietary or allergen labels says so instead of a blank cell.
test('a dish with nothing listed shows None listed, never allergen-free', async ({ page }) => {
  await compare(page, 'Fresh Fruit Cup', 'Avocado Toast', 'edge-cases');
  const section = page.locator('.pp-compare__section--dietary');
  await expect(section.locator('[data-side="first"]')).toContainText('None listed');
  await expect(section.locator('[data-side="other"]')).not.toContainText('None listed');
  await expect(page.getByText(/allergen-free/i)).toHaveCount(0);
});

test('a Wheat dish never shows Gluten-free on the result', async ({ page }) => {
  await compare(page, 'Berry Pancake Stack', 'Avocado Toast', 'edge-cases');
  const pancakes = page.locator('[data-side="first"]');
  await expect(pancakes.getByRole('img', { name: 'Contains Wheat' })).toBeVisible();
  await expect(pancakes.getByRole('img', { name: 'Gluten-free' })).toHaveCount(0);
  await expect(pancakes.getByText('Gluten-free')).toHaveCount(0);
});

test('the compare flow makes no network request', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=demo');
  await page.waitForLoadState('networkidle');
  const requests: string[] = [];
  page.on('request', (request) => {
    // Bundled icon files are static assets of the page itself, not data leaving it.
    const url = request.url();
    if (!url.startsWith('data:') && !/\/assets\/icons\/.+\.svg(\?|$)/.test(url)) {
      requests.push(url);
    }
  });
  await page.getByRole('button', { name: 'Open Avocado Toast' }).first().click();
  await page.locator('.pp-detail__compare').click();
  await page.getByRole('button', { name: 'Compare with Harvest Power Bowl' }).click();
  await page.locator('.pp-picker__confirm').click();
  await page.getByRole('button', { name: 'Replace Harvest Power Bowl' }).click();
  await page.getByRole('button', { name: 'Compare with Salmon Poke Bowl' }).click();
  await page.locator('.pp-picker__confirm').click();
  await page.getByRole('button', { name: 'Back to Menu' }).click();
  expect(requests).toEqual([]);
});

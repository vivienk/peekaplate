// S3-DIN-02.3 Compare picker on synthetic fixtures (Figma "Compare Dish"). Evidence is fixture
// only: no live menu, network or tracking is involved.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const STAFF_LINE = 'For allergy questions, please ask the restaurant staff.';

async function openPicker(page: Page, dishName = 'Avocado Toast') {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=demo');
  await page
    .getByRole('button', { name: `Open ${dishName}` })
    .first()
    .click();
  await expect(page.locator('.pp-detail')).toBeVisible();
  await page.getByRole('button', { name: 'Compare' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Compare Dish' })).toBeVisible();
}

const optionNames = (page: Page) => page.locator('.pp-picker__option .pp-card__name-text');

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

test('Compare on a dish detail opens the picker with that dish as Keeping', async ({ page }) => {
  await openPicker(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Compare Dish' })).toBeFocused();
  await expect(page.locator('.pp-picker__kept-name')).toHaveText('Avocado Toast');
  await expect(page.getByText('Choose a dish to compare')).toBeVisible();

  // The kept dish and incomplete dishes are not options.
  await expect(optionNames(page)).toHaveText([
    'Classic Eggs Benedict',
    'Harvest Power Bowl',
    'Salmon Poke Bowl',
    'Garden Avocado Salad',
  ]);
  await expect(page.locator('.pp-picker__option .pp-picker__option-heart').first()).toBeDisabled();

  // The picker starts at the top and fills the 390px frame, like the menu and detail: the app
  // container's placeholder margin and padding must not apply (Adam, PR #127).
  const box = await page.locator('.pp-picker').boundingBox();
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(390);
  await expectNoAxeViolations(page);
});

// Rania (Nov 13): the check must sit on the selected photo's outer top corner, never over the
// middle of the card, whichever side the photo is on.
async function expectCheckOnPhotoCorner(page: Page) {
  const card = page.locator('.pp-picker__option--selected');
  const [check, photo] = await Promise.all([
    card.locator('.pp-picker__check').boundingBox(),
    card.locator('.pp-picker__option-media').boundingBox(),
  ]);
  if (!check || !photo) throw new Error('selected card is not rendered');
  // Fully inside the photo's top area…
  expect(check.x).toBeGreaterThanOrEqual(photo.x);
  expect(check.x + check.width).toBeLessThanOrEqual(photo.x + photo.width);
  expect(check.y).toBeLessThan(photo.y + photo.height / 2);
  // …and on its outer half, away from the card's middle.
  const photoCenter = photo.x + photo.width / 2;
  const cardBox = await card.boundingBox();
  if (!cardBox) throw new Error('selected card is not rendered');
  const cardCenter = cardBox.x + cardBox.width / 2;
  const checkCenter = check.x + check.width / 2;
  expect(Math.abs(checkCenter - cardCenter)).toBeGreaterThan(Math.abs(photoCenter - cardCenter));
}

// Azoz review #7: a selection that search hides must not stay confirmable.
test('searching away the selected dish clears the selection', async ({ page }) => {
  await openPicker(page);
  const salmon = page.getByRole('button', { name: 'Compare with Salmon Poke Bowl' });
  await salmon.click();
  await expect(salmon).toHaveAttribute('aria-pressed', 'true');

  const search = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });
  await search.fill('avocado');
  await expect(salmon).toHaveCount(0);
  await expect(page.locator('.pp-picker__option--selected')).toHaveCount(0);
  await expect(page.locator('.pp-picker__confirm')).toBeDisabled();

  await search.fill('');
  await expect(salmon).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.pp-picker__option--selected')).toHaveCount(0);
});

test('one dish is selected at a time, with the orange border and check', async ({ page }) => {
  await openPicker(page);
  const bowl = page.getByRole('button', { name: 'Compare with Harvest Power Bowl' });
  const salad = page.getByRole('button', { name: 'Compare with Garden Avocado Salad' });

  await bowl.click();
  await expect(bowl).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.pp-picker__option--selected .pp-card__name-text')).toHaveText(
    'Harvest Power Bowl',
  );
  await expect(page.locator('.pp-picker__option--selected .pp-picker__check')).toBeVisible();
  await expectCheckOnPhotoCorner(page);

  // Tapping the card body selects too, and replaces the previous choice.
  await page.locator('.pp-picker__option', { hasText: 'Garden Avocado Salad' }).click({
    position: { x: 20, y: 100 },
  });
  await expect(salad).toHaveAttribute('aria-pressed', 'true');
  await expect(bowl).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.pp-picker__option--selected')).toHaveCount(1);
  await expectCheckOnPhotoCorner(page);
  // Cards alternate the photo side: Salmon Poke Bowl has its photo on the right, and its check
  // must sit on that photo's outer corner as well, not over the middle of the card.
  await page.getByRole('button', { name: 'Compare with Salmon Poke Bowl' }).click();
  await expectCheckOnPhotoCorner(page);
  await salad.click();

  // Compare is enabled once a dish is selected (the result is covered in compare-result.spec.ts).
  await expect(page.locator('.pp-picker__confirm')).toBeEnabled();
  await expect(page.getByText('Compare results are not available yet.')).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/compare-picker-selected-fixture.png',
    fullPage: true,
  });
  await expectNoAxeViolations(page);
});

test('picker search uses the menu rules, with no results, Clear and the staff line', async ({
  page,
}) => {
  await openPicker(page);
  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });

  await input.fill('benedict');
  await expect(optionNames(page)).toHaveText(['Classic Eggs Benedict']);
  await expect(page.locator('#pp-picker-status')).toHaveText('1 dish found');

  await input.fill('salads');
  await expect(optionNames(page)).toHaveText(['Garden Avocado Salad']);

  await input.fill('avocado');
  await expect(optionNames(page)).toHaveText(['Harvest Power Bowl', 'Garden Avocado Salad']);
  await expect(page.getByText(STAFF_LINE)).toBeHidden();

  await input.fill('gluten-free');
  await expect(page.getByText(STAFF_LINE)).toBeVisible();
  await expect(optionNames(page).first()).toBeVisible();

  await input.fill('gluten');
  await expect(page.getByText(STAFF_LINE)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No Result Found' })).toBeVisible();

  await input.fill('pizza');
  await expect(page.getByRole('heading', { name: 'No Result Found' })).toBeVisible();
  await expect(optionNames(page)).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/compare-picker-no-results-fixture.png',
    fullPage: true,
  });
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(optionNames(page)).toHaveCount(4);
});

test('close and Escape return to the dish detail on its Compare button', async ({ page }) => {
  await openPicker(page);
  await page.getByRole('button', { name: 'Close compare' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Avocado Toast' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare' })).toBeFocused();

  // Escape in a typed search clears it first; a second Escape closes the picker.
  await page.getByRole('button', { name: 'Compare' }).click();
  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });
  await input.fill('pizza');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await expect(page.getByRole('heading', { level: 1, name: 'Compare Dish' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Compare' })).toBeFocused();

  // Back from that detail still returns to the menu.
  await page.locator('.pp-detail__back').click();
  await expect(page.getByRole('button', { name: 'Open Avocado Toast' }).first()).toBeVisible();
});

test('the picker sends no request, fires no tracking call and never logs the query', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=demo');
  await page.waitForLoadState('networkidle');
  const requests: string[] = [];
  const logs: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('data:')) requests.push(request.url());
  });
  page.on('console', (message) => logs.push(message.text()));

  await page.getByRole('button', { name: 'Open Avocado Toast' }).first().click();
  await page.getByRole('button', { name: 'Compare' }).click();
  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });
  // Only the picker phase counts: the detail's own opening and its final checkpoint on leaving
  // are DIN-01 events, so the log is read from here until just before the picker closes.
  await page.waitForTimeout(200);
  const pickerStart = logs.length;
  for (const query of ['benedict', 'pizza', 'gluten']) await input.fill(query);
  await input.fill('');
  await page.getByRole('button', { name: 'Compare with Salmon Poke Bowl' }).click();
  await page.waitForTimeout(200);
  const pickerLogs = logs.slice(pickerStart);
  await page.getByRole('button', { name: 'Close compare' }).click();

  expect(requests).toEqual([]);
  expect(pickerLogs.filter((text) => text.includes('[track]'))).toEqual([]);
  for (const query of ['benedict', 'pizza']) {
    expect(logs.some((text) => text.toLowerCase().includes(query))).toBe(false);
  }
  expect(page.url()).toBe('http://127.0.0.1:5173/?scenario=demo');
});

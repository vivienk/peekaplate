// S3-DIN-01.4 menu search screen on synthetic fixtures (Figma "Search State"). Evidence is fixture
// only: no live menu, network or tracking is involved.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const STAFF_LINE = 'For allergy questions, please ask the restaurant staff.';

async function openMenu(page: Page, scenario = 'demo') {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:5173/?scenario=${scenario}`);
  await expect(page.locator('.pp-category:not([hidden]) .pp-card').first()).toBeVisible({
    timeout: 10_000,
  });
}

const visibleCards = (page: Page) =>
  page.locator('.pp-category:not([hidden]) .pp-card:not([hidden]) .pp-card__name-text');

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

test('the search icon opens the bar and the results are the normal dish cards', async ({
  page,
}) => {
  await openMenu(page);
  const toggle = page.getByRole('button', { name: 'Search menu' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });
  await expect(input).toBeFocused();
  await input.fill('avocado');

  await expect(visibleCards(page)).toHaveText([
    'Avocado Toast',
    'Harvest Power Bowl',
    'Garden Avocado Salad',
  ]);
  await expect(page.getByRole('status').filter({ hasText: 'dishes found' })).toHaveText(
    '3 dishes found',
  );
  await expect(page.getByText(STAFF_LINE)).toBeHidden();
  await expect(page.locator('.pp-tab--active')).toHaveText('All');

  await page.screenshot({ path: 'test-results/search-results-fixture.png', fullPage: true });
  await expectNoAxeViolations(page);

  // A result opens its dish detail like any menu card, and Back returns to the same results.
  await page.getByRole('button', { name: 'Open Harvest Power Bowl' }).click();
  await expect(page.locator('.pp-detail')).toBeVisible();
  await page.locator('.pp-detail__back').click();
  await expect(input).toHaveValue('avocado');
  await expect(visibleCards(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Open Harvest Power Bowl' })).toBeFocused();
});

test('no results shows the Figma state, and Clear search restores the menu', async ({ page }) => {
  await openMenu(page);
  const allCards = await visibleCards(page).count();
  await page.getByRole('button', { name: 'Search menu' }).click();
  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });
  await input.fill('pizza');

  await expect(page.getByRole('heading', { name: 'No Result Found' })).toBeVisible();
  await expect(page.getByText('Try a different dish name or ingredient.')).toBeVisible();
  await expect(visibleCards(page)).toHaveCount(0);
  await expect(page.locator('#pp-search-status')).toHaveText('No dishes found');
  await page.screenshot({ path: 'test-results/search-no-results-fixture.png', fullPage: true });
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(page.getByRole('heading', { name: 'No Result Found' })).toBeHidden();
  await expect(visibleCards(page)).toHaveCount(allCards);
});

test('the staff line shows only for allergen and dietary searches', async ({ page }) => {
  await openMenu(page);
  await page.getByRole('button', { name: 'Search menu' }).click();
  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });

  await input.fill('eggs');
  await expect(page.getByText(STAFF_LINE)).toBeVisible();
  await expect(visibleCards(page)).toContainText(['Avocado Toast']);

  // "gluten" never matches "Gluten-free" dishes, but still points diners to staff.
  await input.fill('gluten');
  await expect(page.getByText(STAFF_LINE)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No Result Found' })).toBeVisible();

  await input.fill('gluten-free');
  await expect(page.getByText(STAFF_LINE)).toBeVisible();
  await expect(visibleCards(page).first()).toBeVisible();

  await input.fill('toast');
  await expect(page.getByText(STAFF_LINE)).toBeHidden();
});

test('incomplete dishes never appear as results', async ({ page }) => {
  await openMenu(page, 'edge-cases');
  await page.getByRole('button', { name: 'Search menu' }).click();
  await page.getByRole('searchbox', { name: 'Search dishes or ingredients' }).fill('a');
  await expect(visibleCards(page).first()).toBeVisible();
  await expect(
    page.locator('.pp-category:not([hidden]) .pp-card--placeholder:not([hidden])'),
  ).toHaveCount(0);
});

test('search works from the keyboard: Enter keeps the page, Escape closes', async ({ page }) => {
  await openMenu(page);
  const url = page.url();
  const toggle = page.getByRole('button', { name: 'Search menu' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });
  await expect(input).toBeFocused();

  await page.keyboard.type('salad');
  await page.keyboard.press('Enter');
  expect(page.url()).toBe(url);
  // Seasonal Green Salad is incomplete in the demo fixtures, so only one salad is a result.
  await expect(visibleCards(page)).toHaveText(['Garden Avocado Salad']);

  await input.focus();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(input).toBeHidden();
  await expect(page.getByRole('heading', { name: 'No Result Found' })).toBeHidden();
  await expect(visibleCards(page).first()).toBeVisible();
});

test('a category tab narrows the results while searching', async ({ page }) => {
  await openMenu(page);
  await page.getByRole('button', { name: 'Search menu' }).click();
  await page.getByRole('searchbox', { name: 'Search dishes or ingredients' }).fill('avocado');
  await page.locator('.pp-tab', { hasText: 'Salads' }).click();
  await expect(visibleCards(page)).toHaveText(['Garden Avocado Salad']);
  await expect(page.locator('#pp-search-status')).toHaveText('1 dish found');
});

test('searching sends no request, fires no tracking call and never logs the query', async ({
  page,
}) => {
  await openMenu(page);
  await page.waitForLoadState('networkidle');
  const requests: string[] = [];
  const logs: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('console', (message) => logs.push(message.text()));

  await page.getByRole('button', { name: 'Search menu' }).click();
  const input = page.getByRole('searchbox', { name: 'Search dishes or ingredients' });
  for (const query of ['avocado', 'pizza', 'eggs', 'gluten-free']) await input.fill(query);
  await page.getByRole('button', { name: 'Close search' }).click();

  expect(requests).toEqual([]);
  expect(logs.filter((text) => text.includes('[track]'))).toEqual([]);
  for (const query of ['avocado', 'pizza', 'eggs']) {
    expect(logs.some((text) => text.toLowerCase().includes(query))).toBe(false);
  }
  expect(page.url()).not.toContain('avocado');
});

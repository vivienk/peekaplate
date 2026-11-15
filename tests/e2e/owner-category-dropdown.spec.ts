import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// Screen 9 Category field: Rania's "Owner / Category dropdown" (Figma 2985:15555) in the dev-only
// owner dashboard demo.
const demo = 'http://127.0.0.1:5174/owner-dashboard.html';

async function openAddDish(page: Page) {
  await page.goto(demo);
  await page.getByRole('button', { name: 'Menu', exact: true }).first().click();
  await page
    .getByRole('button', { name: /Add dish/ })
    .first()
    .click();
  const field = page.getByRole('combobox', { name: /Category/ });
  await expect(field).toHaveText('Select category');
  return field;
}

test('pointer: open the list, pick a category and see it in the field', async ({ page }) => {
  const field = await openAddDish(page);
  await field.click();
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option')).toHaveText([
    'Add category',
    'Breakfast',
    'Brunch Bowls',
    'Salads',
  ]);
  // Nothing is highlighted until the pointer moves over a row.
  await expect(list.locator('[data-active]')).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).include('.s09-cat').analyze();
  expect(axe.violations).toEqual([]);
  await list.getByRole('option', { name: 'Brunch Bowls' }).click();
  await expect(field).toHaveText('Brunch Bowls');
  await expect(field).toHaveAttribute('aria-expanded', 'false');
  // Clicking the field again opens the list with the choice marked as selected.
  await field.click();
  await expect(page.getByRole('option', { name: 'Brunch Bowls' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Clicking outside closes it.
  await page.getByRole('heading', { level: 1 }).first().click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('Add category: the new category joins the list for the owner to select', async ({ page }) => {
  const field = await openAddDish(page);
  await field.click();
  await page.getByRole('option', { name: 'Add category' }).click();
  const input = page.getByLabel('New category name');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', 'Enter category name');
  // An empty name adds nothing.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(input).toBeVisible();
  await input.fill('  Desserts ');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    'Add category',
    'Breakfast',
    'Brunch Bowls',
    'Salads',
    'Desserts',
  ]);
  await expect(field).toHaveText('Select category');
  await page.getByRole('option', { name: 'Desserts' }).click();
  await expect(field).toHaveText('Desserts');
  // A name that already exists (any case) is not added twice.
  await field.click();
  await page.getByRole('option', { name: 'Add category' }).click();
  await page.getByLabel('New category name').fill('salads');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: 'Salads', exact: true })).toHaveCount(1);
});

for (const keyboard of [false, true]) {
  test(`a category named add is selectable by ${keyboard ? 'keyboard' : 'pointer'}`, async ({
    page,
  }) => {
    const field = await openAddDish(page);
    await field.click();
    await page.getByRole('option', { name: 'Add category', exact: true }).click();
    await page.getByLabel('New category name').fill('add');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const ids = await page
      .getByRole('option')
      .evaluateAll((options) => options.map((option) => option.id));
    expect(new Set(ids).size).toBe(ids.length);
    if (keyboard) {
      await field.focus();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
    }
    else await page.getByRole('option', { name: 'add', exact: true }).click();
    await expect(field).toHaveText('add');
    await expect(field).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByLabel('New category name')).toHaveCount(0);
  });
}

test('keyboard: open, move, select and cancel as the handoff describes', async ({ page }) => {
  const field = await openAddDish(page);
  await field.focus();
  await page.keyboard.press('ArrowDown');
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  // The highlight starts on the first row and follows the arrow keys.
  const active = () => page.locator('.s09-cat__option[data-active]');
  await expect(active()).toHaveText('Add category');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(active()).toHaveText('Brunch Bowls');
  const activeId = await active().getAttribute('id');
  await expect(field).toHaveAttribute('aria-activedescendant', activeId ?? '');
  await page.keyboard.press('Enter');
  await expect(field).toHaveText('Brunch Bowls');
  await expect(field).toBeFocused();
  // Esc closes the list and keeps focus on the field.
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await expect(field).toHaveAttribute('aria-expanded', 'false');
  await expect(field).toBeFocused();
  // Esc in "Add category" cancels and returns focus to the field.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('New category name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toBeFocused();
  await expect(field).toHaveText('Brunch Bowls');
});

test('a missing category is reported on the field and clears once chosen', async ({ page }) => {
  const field = await openAddDish(page);
  // The button looks inactive until the form is complete but stays clickable to show the errors.
  await page.getByRole('button', { name: 'Continue to review' }).click({ force: true });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#f-cat-error')).toHaveText('Error: Select a category');
  await field.click();
  await page.getByRole('option', { name: 'Salads' }).click();
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#f-cat-error')).toHaveCount(0);
});

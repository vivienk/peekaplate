import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const demo = 'http://127.0.0.1:5174/review-dishes.html';

// S10 Menu Review (S5-FE-10), synthetic demo. S10 is verification only: it never publishes.
// The pure rules and the markup are covered by Vitest; these tests cover what static markup
// cannot: focus, keyboard, the "Menu verified" pop-up and layout.

test('the demo is labelled as synthetic and Complete verification waits for every dish to be Ready', async ({
  page,
}) => {
  await page.goto(demo);
  await expect(page.getByRole('heading', { level: 1, name: 'Your dishes' })).toBeVisible();
  await expect(page.getByText('Synthetic demo', { exact: false })).toBeVisible();
  const complete = page.getByRole('button', { name: 'Complete verification' });
  await expect(complete).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and Exit' })).toBeVisible();

  // Edit and + Add dish open the Screen 9 form (the dish form), not a stand-in.
  await page.getByRole('button', { name: 'Edit Berry Pancake Stack' }).click();
  await expect(page.getByLabel('Dish name')).toHaveValue('Berry Pancake Stack');
  await page.goto(demo);
  await page.getByRole('button', { name: '+ Add dish' }).click();
  await expect(page.getByLabel('Dish name')).toHaveValue('');
  await page.goto(demo);
  await expect(page.getByText('7 dishes extracted')).toBeVisible();
  await expect(page.getByText('Price Missing')).toBeVisible();
  await expect(complete).toHaveCount(0);

  await page.getByLabel('Menu state').selectOption('ready');
  await expect(complete).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test('Remove moves focus to Undo and Undo returns focus to that dish Edit button', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('button', { name: 'Remove Berry Pancake Stack' }).focus();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Dish removed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
  await expect(page.getByText('Berry Pancake Stack')).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page.getByText('Dish restored.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Berry Pancake Stack' })).toBeFocused();
});

test('removing the only dishes that need fixes (price, category, serving size) shows Complete verification, and Undo hides it', async ({
  page,
}) => {
  await page.goto(demo);
  const complete = page.getByRole('button', { name: 'Complete verification' });
  await page.getByRole('button', { name: 'Remove Berry Pancake Stack' }).click();
  await expect(complete).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove Brioche French Toast' }).click();
  await expect(complete).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove Classic Eggs Benedict' }).click();
  await expect(complete).toBeEnabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(complete).toHaveCount(0);
});

test('the whole screen works from the keyboard in a sensible order', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Menu state').selectOption('ready');
  // Walk the screen: Add dish, then each row (Edit, Remove), then the footer.
  await page.getByRole('button', { name: '+ Add dish' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Edit Avocado Toast' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Remove Avocado Toast' })).toBeFocused();

  await page.getByRole('button', { name: 'Save and Exit' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Complete verification' })).toBeFocused();
});

test('a failed verification stays on the screen with a retry', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Menu state').selectOption('fails');
  const complete = page.getByRole('button', { name: 'Complete verification' });
  await complete.click();
  await expect(page.getByRole('alert')).toContainText('We could not complete verification');
  await expect(complete).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Complete verification shows Menu verified, Escape keeps it open and Go to dashboard continues', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('Menu state').selectOption('ready');
  await page.getByRole('button', { name: 'Complete verification' }).click();

  const dialog = page.getByRole('dialog', { name: 'Menu verified' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'Your menu details are confirmed. Verification does not publish your menu.',
  );
  const goToDashboard = page.getByRole('button', { name: 'Go to dashboard' });
  await expect(goToDashboard).toBeFocused();

  // The design has one button and no close control: Escape must not close the pop-up.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  await goToDashboard.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Your dishes' })).toHaveCount(0);
  // Verification never publishes: S12 still offers "Review and publish" as the next step.
  await expect(page.getByText('Review and publish').first()).toBeVisible();
  await expect(
    page.getByText('Demo only: this is S12 after verification', { exact: false }),
  ).toBeVisible();
});

test('an empty menu cannot be verified', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Menu state').selectOption('empty');
  await expect(page.getByText('No dishes yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete verification' })).toHaveCount(0);
});

for (const [name, size] of [
  ['desktop', { width: 1280, height: 900 }],
  ['mobile 390px', { width: 390, height: 844 }],
] as const) {
  test(`${name}: no accessibility violations and no sideways page scroll`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(demo);
    await expect(page.getByRole('heading', { level: 1, name: 'Your dishes' })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

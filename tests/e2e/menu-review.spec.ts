import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const demo = 'http://127.0.0.1:5174/review-dishes.html';

// S10 Menu Review and Publish (S5-FE-10), synthetic demo. The pure rules and the markup are
// covered by Vitest; these tests cover what static markup cannot: focus, keyboard and layout.

test('the demo is labelled as synthetic and Publish Menu waits for every dish to be Ready', async ({
  page,
}) => {
  await page.goto(demo);
  await expect(page.getByRole('heading', { level: 1, name: 'Your dishes' })).toBeVisible();
  await expect(page.getByText('Synthetic demo', { exact: false })).toBeVisible();
  const publish = page.getByRole('button', { name: 'Publish Menu' });
  await expect(publish).toBeDisabled();
  await expect(page.getByText('Publish Menu opens when every dish is Ready.')).toBeVisible();

  await page.getByRole('button', { name: 'Edit Berry Pancake Stack' }).click();
  await expect(publish).toBeDisabled();
  await page.getByRole('button', { name: 'Edit Brioche French Toast' }).click();
  await expect(publish).toBeEnabled();
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

test('removing the only dishes that need fixes turns Publish Menu on, and Undo turns it off', async ({
  page,
}) => {
  await page.goto(demo);
  const publish = page.getByRole('button', { name: 'Publish Menu' });
  await page.getByRole('button', { name: 'Remove Berry Pancake Stack' }).click();
  await expect(publish).toBeDisabled();
  await page.getByRole('button', { name: 'Remove Brioche French Toast' }).click();
  await expect(publish).toBeEnabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(publish).toBeDisabled();
});

test('the whole screen works from the keyboard in a sensible order', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Menu state').selectOption('ready');
  // Skip the demo bar, then walk the screen: Add dish, then each row (Edit, Remove), then footer.
  await page.getByRole('button', { name: '+ Add dish' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Edit Avocado Toast' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Remove Avocado Toast' })).toBeFocused();

  await page.getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save and Exit' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Publish Menu' })).toBeFocused();
});

test('publishing shows the success pop-up, and a failure stays on the screen with a retry', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('Menu state').selectOption('fails');
  const publish = page.getByRole('button', { name: 'Publish Menu' });
  await publish.click();
  await expect(page.getByRole('alert')).toContainText('We could not publish your menu');
  await expect(publish).toBeEnabled();

  await page.getByLabel('Menu state').selectOption('ready');
  await publish.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/published/i);
  await expect(dialog).not.toContainText(/verif/i);
});

test('an empty menu cannot be published', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Menu state').selectOption('empty');
  await expect(page.getByText('No dishes yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish Menu' })).toBeDisabled();
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

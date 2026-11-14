import { expect, test } from '@playwright/test';

const demo = 'http://127.0.0.1:5174/first-dashboard.html';

for (const dismissal of ['button', 'Escape'] as const) {
  test(`publish success restores dashboard focus after ${dismissal}`, async ({ page }) => {
    await page.goto(demo);
    await page.getByLabel('Setup state').selectOption('unpublished');
    await page.getByRole('button', { name: 'Review and publish', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Your menu is published' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Go to dashboard' })).toBeFocused();
    if (dismissal === 'button') {
      await dialog.getByRole('button', { name: 'Go to dashboard' }).click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#owner-content')).toBeFocused();
  });
}

test('onboarding keeps publication locked and fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(demo);
  for (const state of ['fresh', 'submitted', 'details', 'unpublished']) {
    await page.getByLabel('Setup state').selectOption(state);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    if (state === 'fresh' || state === 'submitted') {
      await expect(
        page.getByRole('button', { name: 'Review and publish', exact: true }),
      ).toHaveCount(0);
    }
  }
});

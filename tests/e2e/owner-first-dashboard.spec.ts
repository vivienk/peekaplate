import { expect, test } from '@playwright/test';

for (const width of [320, 390, 1440]) {
  test(`synthetic first-dashboard states fit ${width}px without live actions`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1:5174/first-dashboard.html');
    for (const state of ['fresh', 'details', 'unpublished']) {
      await page.getByLabel('Setup state').selectOption(state);
      await expect(page.getByText('Synthetic demo', { exact: false })).toBeVisible();
      await expect(page.getByLabel('Ask about your dishes')).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  });
}

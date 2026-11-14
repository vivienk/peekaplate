import { expect, test } from '@playwright/test';

// Dev-only owner dashboard demo (#105). At phone width the AI opens as a modal drawer.
const demo = 'http://127.0.0.1:5174/owner-dashboard.html';

test.use({ viewport: { width: 390, height: 844 } });

test('AI drawer takes focus, keeps Tab inside and closes on Escape', async ({ page }) => {
  await page.goto(demo);
  const opener = page.getByRole('button', { name: 'Ask AI' });
  await opener.focus();
  await page.keyboard.press('Enter');

  const drawer = page.getByRole('dialog', { name: 'Ask PeekaPlate AI' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  // Focus moves inside the drawer on open.
  await expect(page.getByRole('button', { name: 'Close chat' })).toBeFocused();

  // The page behind is inert, so it is out of the keyboard and accessibility order.
  const pageInert = () =>
    page.evaluate(() => Boolean(document.getElementById('content')?.closest('[inert]')));
  expect(await pageInert()).toBe(true);

  // Tab and Shift+Tab never leave the drawer.
  const insideDrawer = () =>
    page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    expect(await insideDrawer()).toBe(true);
  }
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await insideDrawer()).toBe(true);
  }

  // Escape closes the drawer, restores the page and returns focus to the opener.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  expect(await pageInert()).toBe(false);
  await expect(opener).toBeFocused();
});

test('closing the AI drawer with its button returns focus to the opener', async ({ page }) => {
  await page.goto(demo);
  const opener = page.getByRole('button', { name: 'Ask AI' });
  await opener.click();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByRole('dialog', { name: 'Ask PeekaPlate AI' })).toHaveCount(0);
  await expect(opener).toBeFocused();
});

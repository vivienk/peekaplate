import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// S13 owner menu preview and publish (preview-only demo). The phone frames the local diner dev
// server, which the default config starts on 127.0.0.1:5173.
const demo = 'http://127.0.0.1:5174/owner-menu-preview.html';

test('the draft preview shows the real diner menu and no public link before publishing', async ({
  page,
}) => {
  await page.goto(demo);
  await expect(page.getByRole('heading', { level: 1, name: 'Preview your menu' })).toBeVisible();
  await expect(page.getByText('Preview — Not Published')).toBeVisible();
  // Sai, 15 Nov: no public link before publishing; the link field appears only after.
  await expect(page.getByRole('textbox', { name: 'Menu link' })).toHaveCount(0);
  await expect(
    page.getByText('Your menu link appears here after you publish.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByText('7 dishes · 3 categories')).toBeVisible();

  // The phone shows the diner app itself, and it scrolls inside the phone.
  const diner = page.frameLocator('iframe[title="Ember & Stone diner menu preview"]');
  await expect(diner.getByText('Avocado Toast').first()).toBeVisible();
  const frame = page.frames().find((f) => f.url().startsWith('http://127.0.0.1:5173'));
  expect(frame).toBeDefined();
  const scrolled = await frame?.evaluate(() => {
    window.scrollTo(0, 600);
    return window.scrollY;
  });
  expect(scrolled).toBeGreaterThan(0);

  // The diner app is checked by its own tests; the Figma wordmark is excluded as in the onboarding
  // screens' checks.
  const axe = await new AxeBuilder({ page })
    .exclude('iframe')
    .exclude('.pp-onboard__brand')
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('publishing asks for confirmation, then shows the returned link with Copy Link', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:5174',
  });
  await page.goto(demo);
  const publish = page.getByRole('button', { name: 'Publish Menu' });
  await publish.click();
  const dialog = page.getByRole('dialog', { name: 'Publish your menu?' });
  await expect(dialog).toBeVisible();
  // Escape cancels without publishing.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Requests sent: 0')).toBeVisible();

  await publish.click();
  await dialog.getByRole('button', { name: 'Publish Menu' }).click();
  await expect(page.getByRole('button', { name: 'Publishing' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  const live = page.getByRole('heading', { level: 1, name: 'Your menu is live' });
  await expect(live).toBeVisible();
  await expect(live).toBeFocused();
  await expect(page.getByText('Live — Published')).toBeVisible();
  const link = page.getByRole('textbox', { name: 'Menu link' });
  await expect(link).toHaveValue('https://peekaplate.app/diner/ember-stone');
  await expect(link).toHaveAttribute('readonly', '');

  await page.getByRole('button', { name: 'Copy Link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Link copied.' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'https://peekaplate.app/diner/ember-stone',
  );
  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page.getByText('In the product this opens the S12 dashboard.')).toBeVisible();
});

test('a menu that is not ready cannot be published and points to the dishes', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Menu', { exact: true }).selectOption('not-ready');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Your menu isn’t ready to publish');
  await expect(alert).toContainText('2 dishes are missing a price or category.');
  const publish = page.getByRole('button', { name: 'Publish Menu' });
  await expect(publish).toHaveAttribute('aria-disabled', 'true');
  // It stays focusable but does nothing.
  await publish.click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await alert.getByRole('button', { name: 'Review dishes' }).click();
  await expect(page.getByText('In the product this opens S10 Review dishes.')).toBeVisible();
});

test('a failed publish keeps the menu a draft and lets the owner try again', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Publish answer').selectOption('failure');
  await page.getByRole('button', { name: 'Publish Menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish Menu' }).click();
  await expect(page.getByRole('alert')).toContainText('We couldn’t publish your menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Preview your menu' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Menu link' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish Menu' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('the preview fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(demo);
  await expect(page.getByRole('heading', { level: 1, name: 'Preview your menu' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

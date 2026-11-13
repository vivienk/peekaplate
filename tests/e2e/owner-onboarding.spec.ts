import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// FE-05 S05 Restaurant details on the preview-only onboarding demo. The demo stands in for the
// caller and answers saves with the outcome picked in its bar.
const demo = 'http://127.0.0.1:5174/owner-onboarding.html';

const save = (page: Page) => page.getByRole('button', { name: 'Save' });

async function fillRequired(page: Page) {
  await page.getByLabel('Restaurant name').fill('Ember & Stone');
  await page.getByLabel('City').fill('San Francisco');
  await page.getByLabel('Street address').fill('742 Evergreen Terrace');
  await page.getByLabel('Phone number').fill('(555) 234-5678');
}

test('S05 opens empty with Save unavailable until the required fields are valid', async ({
  page,
}) => {
  await page.goto(demo);
  await expect(page.getByRole('heading', { name: 'Restaurant Details', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Restaurant name')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Contact email')).not.toHaveAttribute('required', '');
  await expect(save(page)).toHaveAttribute('aria-disabled', 'true');
  await fillRequired(page);
  await expect(save(page)).not.toHaveAttribute('aria-disabled');
});

test('pressing Save early shows every error and focuses the first', async ({ page }) => {
  await page.goto(demo);
  await save(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Please correct the highlighted errors before saving.',
  );
  await expect(page.getByLabel('Restaurant name')).toBeFocused();
  await expect(page.getByLabel('Restaurant name')).toHaveAccessibleDescription(
    'Error: Enter your restaurant name',
  );
  await expect(page.getByLabel('City')).toHaveAccessibleDescription('Error: Enter your city');
  await expect(page.getByLabel('Phone number')).toHaveAccessibleDescription(
    'Error: Enter your phone number',
  );
  await expect(page.getByText('Requests sent: 0')).toBeVisible();
});

test('a field error appears when leaving it, and clears once fixed', async ({ page }) => {
  await page.goto(demo);
  const phone = page.getByLabel('Phone number');
  await phone.fill('12');
  await phone.blur();
  await expect(phone).toHaveAccessibleDescription('Error: Enter a valid phone number');
  await phone.fill('(555) 234-5678');
  await expect(phone).not.toHaveAttribute('aria-invalid');
});

test('a valid save shows Saving and then hands over to S06', async ({ page }) => {
  await page.goto(demo);
  await fillRequired(page);
  await save(page).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByLabel('City')).toHaveAttribute('readonly', '');
  await expect(
    page.getByText('In the product this opens S06 Choose how to add your menu'),
  ).toBeVisible();
});

test('a failed save keeps the details and says so', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Save answer').selectOption('failed');
  await fillRequired(page);
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText('We couldn’t save your restaurant details');
  await expect(page.getByLabel('City')).toHaveValue('San Francisco');
});

test('from the dashboard, Save needs a change and restoring the value disables it again', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('S05 opened from').selectOption('dashboard');
  await expect(page.getByLabel('Restaurant name')).toHaveValue('Ember & Stone');
  await expect(page.getByRole('button', { name: 'Back to dashboard' })).toBeVisible();
  await expect(save(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel('City').fill('Oakland');
  await expect(save(page)).not.toHaveAttribute('aria-disabled');
  await page.getByLabel('City').fill('San Francisco');
  await expect(save(page)).toHaveAttribute('aria-disabled', 'true');
});

test('choosing a photo previews it and rejects other file types', async ({ page }) => {
  await page.goto(demo);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: 'menu.gif', mimeType: 'image/gif', buffer: Buffer.from('x') });
  await expect(page.getByText('Choose a JPEG or PNG image')).toBeVisible();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('img', { name: 'Restaurant photo' })).toBeVisible();
  await expect(page.getByText('Change photo')).toBeVisible();
});

test('S05 passes the accessibility scan, with and without errors', async ({ page }) => {
  const scan = async () => {
    const { violations } = await new AxeBuilder({ page })
      .include('.pp-onboard')
      .exclude('.pp-onboard__brand')
      .analyze();
    expect(violations).toEqual([]);
  };
  await page.goto(demo);
  await scan();
  await save(page).focus();
  await page.keyboard.press('Enter');
  await scan();
});

test('on a phone the form fits without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(demo);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

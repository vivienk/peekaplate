import { expect, test } from '@playwright/test';

// Screen 9 Add dish: the photo is required, marked with the red * like the other required fields.
const demo = 'http://127.0.0.1:5174/owner-dashboard.html';
// A 1×1 PNG, enough for the browser to read as an image.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('a new dish needs a photo before review, and uploading one clears the error', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('button', { name: 'Menu', exact: true }).first().click();
  await page
    .getByRole('button', { name: /Add dish/ })
    .first()
    .click();

  const heading = page.getByRole('heading', { name: 'Photo (required)' });
  await expect(heading).toBeVisible();
  expect(
    await heading.evaluate((el) => getComputedStyle(el, '::after').content.startsWith('"*"')),
  ).toBe(true);

  // The button looks inactive until the form is complete but stays clickable to show the errors.
  await page.getByRole('button', { name: 'Continue to review' }).click({ force: true });
  const upload = page.getByRole('button', { name: 'Upload photo' });
  await expect(page.locator('#f-photo-error')).toHaveText('Error: Add a photo of the dish');
  await expect(upload).toHaveAttribute('aria-describedby', 'f-photo-error');
  // The error line uses the field error colour, not the card's grey text.
  const colour = await page.locator('#f-photo-error').evaluate((el) => getComputedStyle(el).color);
  const grey = await page
    .locator('.s09-sidecard p:not(.pp-field__error)')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(colour).not.toBe(grey);

  await page.locator('#f-photo-file').setInputFiles({
    name: 'dish.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.getByRole('button', { name: 'Replace photo' })).toBeVisible();
  await expect(page.locator('#f-photo-error')).toHaveCount(0);
  // An uploaded photo then asks for the photo-rights confirmation, as before.
  await expect(page.getByLabel('I have the right to use this photo.')).toBeVisible();
});

test('editing a dish that already has a photo does not ask for another', async ({ page }) => {
  await page.goto(demo);
  await page.getByRole('button', { name: 'Menu', exact: true }).first().click();
  await page.getByRole('button', { name: /Edit/ }).first().click();
  await expect(page.getByRole('button', { name: 'Replace photo' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to review' }).click({ force: true });
  await expect(page.locator('#f-photo-error')).toHaveCount(0);
});

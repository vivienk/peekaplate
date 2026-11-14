import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// Opt-in: requires the real local model service; never substitutes a mocked cutout.
for (const variant of [
  { name: 'Avocado Toast', query: '', legacy: false },
  { name: 'Brioche French Toast', query: '?scenario=edge-cases', legacy: false },
  { name: 'Avocado Toast', query: '?scenario=portion-demo', legacy: true },
]) {
  test(`uploaded opaque photo works for ${variant.name} ${variant.query}`, async ({ page }) => {
    test.skip(
      !process.env.PEEKAPLATE_LIVE_CUTOUT,
      'Start the local cutout service and explicitly enable this integration check.',
    );
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'xr', { value: undefined, configurable: true });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          const context = canvas.getContext('2d')!;
          context.fillStyle = '#8b7766';
          context.fillRect(0, 0, 640, 480);
          return canvas.captureStream(5);
        },
      });
    });
    await page.goto(
      (process.env.PEEKAPLATE_UPLOAD_URL || 'http://127.0.0.1:5175/') + variant.query,
    );
    await page.getByRole('button', { name: `Open ${variant.name}`, exact: true }).click();
    if (variant.legacy) {
      await page.getByRole('button', { name: 'View Portion', exact: true }).click();
      await page
        .getByRole('button', { name: 'Back to preview', exact: true })
        .click({ timeout: 20000 });
      await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
    }
    const reply = page.waitForResponse(
      (response) =>
        response.url().includes('/v1/portion-uploads/') && response.request().method() === 'POST',
      { timeout: 210_000 },
    );
    await page
      .getByLabel('Upload dish photo for 2.5D preview')
      .setInputFiles(resolve('frontend/diner/src/menu/fixture-assets/portion-demo/photo.jpg'));
    await page.getByLabel('Plate width in centimetres').fill('28');
    await page.getByLabel('I measured this plate').check();
    await page.getByLabel('Plate boundary left percent').fill('12');
    await expect(page.getByLabel('I measured this plate')).not.toBeChecked();
    await page.getByLabel('I measured this plate').check();
    await page.getByRole('button', { name: 'Generate preview', exact: true }).click();
    const response = await reply;
    expect(response.ok()).toBe(true);
    await expect(page.getByRole('dialog', { name: 'Dish on your table' })).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByRole('dialog', { name: 'Dish on your table' })
      .getByText('Adjust view', { exact: true })
      .click();
    await expect(
      page
        .getByRole('dialog', { name: 'Dish on your table' })
        .getByText(/Your uploaded photo. Automatic cutout/),
    ).toBeVisible();
    await expect(page.locator('.pp-ar__scale-status')).toContainText('28 × 28 cm');
    await expect(page.locator('.pp-ar__scale-status')).toContainText('approximate');
    await page.getByRole('button', { name: 'Original photo', exact: true }).click();
    await expect(page.locator('.pp-ar__original')).toBeVisible();
    await expect(page.locator('.pp-ar__original')).toHaveAttribute('src', /^blob:/);
    await page.getByRole('button', { name: 'Return to AR', exact: true }).click();
    await expect(page.locator('.pp-ar__original')).toBeHidden();
    const rotation = page.getByRole('slider', { name: 'Rotate dish' });
    await rotation.fill('30');
    await expect(rotation).toHaveValue('30');
    await page.screenshot({ path: '/private/tmp/automatic-cutout-camera-test.png' });
    await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
    await page.getByText('Preview controls', { exact: true }).click();
    await expect(page.getByLabel('Preview image (local review only)')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Generate 3D/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show original photo', exact: true }).click();
    await expect(page.locator('.pp-detail__image')).toHaveAttribute('src', /^blob:/);
    await expect(page.locator('.pp-detail__image-wrap')).toHaveClass(/pp-portion--original/);
    await page.getByRole('button', { name: 'Show review candidate', exact: true }).click();
    await page.getByRole('button', { name: 'Reset view', exact: true }).click();
    await expect(page.locator('.pp-detail__image-wrap')).not.toHaveClass(/pp-portion--original/);
    await page.getByRole('button', { name: 'Back to dish details' }).click();
    await expect(page.getByRole('heading', { name: 'Dish details', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to menu', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Open ${variant.name}`, exact: true }),
    ).toBeVisible();
  });
}

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync('processing/src/peekaplate_processing/review_preview_html.py', 'utf8');
const template = source.split("'''", 3)[1];
const html = template
  .replaceAll('__ASSET__', 'presentation.png')
  .replaceAll('__MODE__', 'generated');
// Synthetic browser-only image; image fidelity is covered by the Python suite.
const image =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><circle cx="256" cy="256" r="180" fill="green"/></svg>';

test.beforeEach(async ({ page }) => {
  await page.route('http://review.test/**', (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith('.html') ? 'text/html' : 'image/svg+xml',
      body: route.request().url().endsWith('.html') ? html : image,
    }),
  );
  await page.goto('http://review.test/index.html');
  await expect(page.locator('#stage')).toHaveClass('ready');
});

test('keyboard is bounded, Home resets and original comparison hides the card', async ({
  page,
}) => {
  const stage = page.locator('#stage');
  for (let i = 0; i < 10; i++) await stage.press('ArrowRight');
  await expect(page.locator('#card')).toHaveAttribute('style', /rotateY\(3deg\)/);
  await stage.press('ArrowLeft');
  await expect(page.locator('#card')).toHaveAttribute('style', /rotateY\(2.5deg\)/);
  await stage.press('Home');
  await expect(page.locator('#card')).toHaveAttribute('style', /rotateY\(0deg\)/);
  await page.locator('#compare').click();
  await expect(page.locator('#card')).toBeHidden();
  await expect(page.locator('#original')).toBeVisible();
});

test('pointer exit returns to center and live reduced motion disables transforms', async ({
  page,
}) => {
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('stage missing');
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await expect(page.locator('#card')).not.toHaveAttribute('style', /rotateY\(0deg\)/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#card')).toHaveCSS('transform', 'none');
  await page.locator('#stage').press('ArrowRight');
  await expect(page.locator('#card')).toHaveCSS('transform', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(0, 0);
  await expect(page.locator('#card')).toHaveAttribute('style', /rotateY\(0deg\)/);
});

test('touch drag resets on release; vertical movement yields to scrolling', async ({ page }) => {
  const stage = page.locator('#stage');
  await expect(stage).toHaveCSS('touch-action', 'pan-y');
  await stage.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 100,
    clientY: 300,
  });
  await stage.dispatchEvent('pointermove', {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 170,
    clientY: 302,
  });
  await expect(page.locator('#card')).not.toHaveAttribute('style', /rotateY\(0deg\)/);
  await stage.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
  await expect(page.locator('#card')).toHaveAttribute('style', /rotateY\(0deg\)/);
  await stage.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 2,
    clientX: 100,
    clientY: 300,
  });
  await stage.dispatchEvent('pointermove', {
    pointerType: 'touch',
    pointerId: 2,
    clientX: 102,
    clientY: 360,
  });
  await expect(page.locator('#card')).toHaveAttribute('style', /rotateY\(0deg\)/);
});

test('failed candidate keeps the original visible', async ({ page }) => {
  await page.route('**/presentation.png', (route) => route.fulfill({ status: 404, body: '' }));
  await page.reload();
  await expect(page.locator('#status')).toContainText('Preview unavailable');
  await expect(page.locator('#card')).toBeHidden();
  await expect(page.locator('#original')).toBeVisible();
});

test('no JavaScript still displays the original photograph', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.route('http://review.test/**', (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith('.html') ? 'text/html' : 'image/svg+xml',
      body: route.request().url().endsWith('.html') ? html : image,
    }),
  );
  await page.goto('http://review.test/index.html');
  await expect(page.locator('#original')).toBeVisible();
  await expect(page.locator('#card')).toBeHidden();
  expect(
    await page.locator('#original').evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBe(512);
  await context.close();
});

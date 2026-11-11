import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// Entirely synthetic HTTP fixtures. Real menu verifier, adapter, UI and WebGL renderer.
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const images = ['background', 'foreground'].map((name) =>
  readFileSync(`tests/fixtures/portion/${name}.png`),
);
const blue = readFileSync('tests/fixtures/portion/foreground-blue.png');
type Mode =
  | 'valid'
  | 'missing'
  | 'wrong-dish'
  | 'wrong-revision'
  | 'broken'
  | 'hash'
  | 'dimensions'
  | 'slow'
  | 'no-photo';
async function openMenu(page: Page, mode: Mode = 'valid') {
  const content = JSON.parse(
    readFileSync('packages/contracts/fixtures/public-menu-bundle.v1/bundle.json', 'utf8'),
  );
  for (const category of content.categories)
    for (const dish of category.dishes) {
      if (!dish.complete || mode === 'missing' || mode === 'no-photo') continue;
      const dishImages = dish.name === 'Roast Chicken' ? [images[0]!, blue] : images;
      dish.portion = {
        schema_version: 1,
        dish_id: mode === 'wrong-dish' ? content.menu_id : dish.dish_id,
        dish_revision_id: mode === 'wrong-revision' ? content.menu_id : dish.dish_revision_id,
        width: mode === 'dimensions' ? 32 : 64,
        height: 64,
        layers: dishImages.map((bytes, depth) => ({
          url: `https://assets.example.test/${dish.dish_id}/${depth}.png`,
          sha256: mode === 'hash' ? 'f'.repeat(64) : hash(bytes),
          size_bytes: bytes.length,
          depth,
        })),
      };
    }
  const bytes = JSON.stringify(content);
  await page.route('**/src/menu/menuScreen.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text())
        .replaceAll('import.meta.env.VITE_MENU_SOURCE', '"live"')
        .replaceAll('import.meta.env.VITE_PUBLIC_API_URL', '"http://127.0.0.1:5173"'),
    });
  });
  await page.route('**/public/venues/**', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        venueId: content.venue_id,
        menuId: content.menu_id,
        menuRevisionId: content.menu_revision_id,
        publicationId: '44444444-4444-4444-8444-444444444444',
        publicationHash: 'a'.repeat(64),
        availabilityVersion: 1,
        tier: 'T0',
        bundle: {
          url: 'https://bundle.example.test/portion.json',
          contentHash: hash(bytes),
          assetManifestHash: 'b'.repeat(64),
        },
        menuToken: 'synthetic-only',
        tokenExpiresAt: new Date(Date.now() + 1800000).toISOString(),
      },
    }),
  );
  await page.route('https://bundle.example.test/portion.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: bytes }),
  );
  await page.route('https://assets.example.test/**', async (route) => {
    const layer = /\/([01])\.png$/.exec(route.request().url());
    if (layer && mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 9000));
    if ((layer && mode === 'broken') || mode === 'no-photo') return route.fulfill({ status: 404 });
    await route.fulfill({
      contentType: 'image/png',
      body:
        layer?.[1] === '1' && route.request().url().includes('000000000150')
          ? blue
          : images[layer ? Number(layer[1]) : 0]!,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
  await page.goto(`http://127.0.0.1:5173/venues/${content.venue_id}/menus/${content.menu_id}`);
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  return content;
}
async function openPortion(page: Page) {
  await page.locator('.pp-card__open').first().click();
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
}

test('menu → dish-specific 2.5D → detail → another dish, with focus and browser navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requested: string[] = [];
  page.on('request', (request) => {
    if (/\/[01]\.png$|portionRenderer/.test(request.url())) requested.push(request.url());
  });
  const content = await openMenu(page);
  await page.locator('.pp-card__open').first().click();
  expect(requested).toEqual([]);
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(page.locator('.pp-portion__status')).toContainText('Drag to tilt the plate');
  await expect(page.locator('canvas')).toHaveCount(1);
  expect(requested.filter((url) => /\/[01]\.png$/.test(url))).toHaveLength(2);
  expect(requested.some((url) => url.includes(content.categories[0].dishes[0].dish_id))).toBe(true);
  const stage = page.getByRole('group', { name: 'Charred Leeks portion preview' });
  await stage.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const firstVisual = hash(await page.locator('canvas').screenshot());
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  expect(hash(await page.locator('canvas').screenshot())).not.toBe(firstVisual);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: 'test-results/portion-390.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.goForward();
  await expect(page.locator('canvas')).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to menu', exact: true }).click();
  await expect(page.locator('.pp-card__open').first()).toBeFocused();
  await page.locator('.pp-category:not([hidden]) .pp-card__open').last().click();
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Roast Chicken portion preview' })).toBeVisible();
  await page.locator('.pp-detail__image-wrap').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  expect(hash(await page.locator('canvas').screenshot())).not.toBe(firstVisual);
  await expect(page.locator('canvas')).toHaveCount(1);
  expect(requested.some((url) => url.includes(content.categories[1].dishes[0].dish_id))).toBe(true);
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.locator('.pp-detail__name')).toHaveText('Roast Chicken');
});

for (const mode of [
  'missing',
  'wrong-dish',
  'wrong-revision',
  'broken',
  'hash',
  'dimensions',
  'no-photo',
] as const) {
  test(`graceful fallback: ${mode}`, async ({ page }) => {
    await openMenu(page, mode);
    await openPortion(page);
    await expect(page.locator('.pp-portion__status')).toContainText(
      mode === 'no-photo' ? 'Couldn’t load preview.' : 'Interactive preview unavailable',
    );
    await expect(page.locator('canvas')).toHaveCount(0);
    if (mode === 'no-photo') {
      const historyLength = await page.evaluate(() => history.length);
      await page.route('https://assets.example.test/**', (route) =>
        route.request().url().includes('/detail-')
          ? route.fulfill({ status: 404 })
          : route.fulfill({ contentType: 'image/png', body: images[0]! }),
      );
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(page.locator('.pp-portion__status')).toContainText('Showing photo instead');
      await expect(page.locator('img.pp-detail__image')).toBeVisible();
      await expect(page.locator('img.pp-detail__image')).toHaveAttribute('src', /card-480/);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
    } else await expect(page.locator('img.pp-detail__image')).toBeVisible();
    await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
    await expect(page.locator('.pp-detail__name')).toHaveText('Charred Leeks');
  });
}

test('closing during loading disposes late work and repeated opens keep one canvas', async ({
  page,
}) => {
  await openMenu(page, 'slow');
  await openPortion(page);
  await expect(page.locator('.pp-portion__status')).toContainText('Loading');
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
  await page.waitForTimeout(9500);
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(page.locator('.pp-portion__status')).toContainText(
    'Interactive preview unavailable',
    {
      timeout: 10000,
    },
  );
});

test('WebGL failure and context loss restore the photo', async ({ page }) => {
  await openMenu(page);
  await openPortion(page);
  await expect(page.locator('canvas')).toHaveCount(1);
  await page
    .locator('canvas')
    .evaluate((canvas) =>
      (canvas as HTMLCanvasElement)
        .getContext('webgl2')
        ?.getExtension('WEBGL_lose_context')
        ?.loseContext(),
    );
  await expect(page.locator('.pp-portion__status')).toContainText(
    'Interactive preview unavailable',
  );
  await expect(page.locator('img.pp-detail__image')).toBeVisible();
});

test('reduced motion renders without requiring motion or WebGL for navigation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMenu(page);
  await openPortion(page);
  await expect(page.locator('.pp-portion__status')).toContainText('Motion is reduced');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
});

test('unavailable WebGL keeps the photo and reload retires a stale preview', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2') return null;
      return original.apply(this, [kind, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  await openMenu(page);
  await openPortion(page);
  await expect(page.locator('.pp-portion__status')).toContainText(
    'Interactive preview unavailable',
  );
  await expect(page.locator('img.pp-detail__image')).toBeVisible();
  await page.reload();
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await openPortion(page);
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
});

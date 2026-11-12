import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// Entirely synthetic HTTP fixtures. Real menu verifier, adapter, UI and PR25 CSS viewer.
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
  | 'no-photo'
  | 'original-missing';
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
    if (
      (layer && mode === 'broken') ||
      mode === 'no-photo' ||
      (!layer && mode === 'original-missing')
    )
      return route.fulfill({ status: 404 });
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
  await expect(page.locator('.pp-portion__css')).toHaveCount(1);
  expect(requested.filter((url) => /\/[01]\.png$/.test(url))).toHaveLength(2);
  expect(requested.some((url) => url.includes(content.categories[0].dishes[0].dish_id))).toBe(true);
  const stage = page.getByRole('group', { name: 'Charred Leeks portion preview' });
  await stage.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const firstVisual = hash(await page.locator('.pp-portion__css').screenshot());
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  expect(hash(await page.locator('.pp-portion__css').screenshot())).not.toBe(firstVisual);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: 'test-results/portion-390.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
  await expect(page.locator('.pp-portion__css')).toHaveCount(0);
  await page.goForward();
  await expect(page.locator('.pp-portion__css')).toHaveCount(1);
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
  expect(hash(await page.locator('.pp-portion__css').screenshot())).not.toBe(firstVisual);
  await expect(page.locator('.pp-portion__css')).toHaveCount(1);
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
    await expect(page.locator('.pp-portion__css')).toHaveCount(0);
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

test('closing during loading disposes late work and repeated opens keep one cutout card', async ({
  page,
}) => {
  await openMenu(page, 'slow');
  await openPortion(page);
  await expect(page.locator('.pp-portion__status')).toContainText('Loading');
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
  await page.waitForTimeout(9500);
  await expect(page.locator('.pp-portion__css')).toHaveCount(0);
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(page.locator('.pp-portion__status')).toContainText(
    'Interactive preview unavailable',
    {
      timeout: 10000,
    },
  );
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

test('unavailable WebGL keeps an interactive cutout and reload retires a stale preview', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2') return null;
      return original.apply(this, [kind, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  await openMenu(page);
  await openPortion(page);
  await expect(page.locator('.pp-portion__status')).toContainText('Drag to tilt the plate');
  await expect(page.locator('.pp-portion__css')).toBeVisible();
  await page.reload();
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await expect(page.locator('.pp-portion__css')).toHaveCount(0);
  await openPortion(page);
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
});

test('local captured-dish demo loads real textures and tilts without route mocks', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await expect(page.locator('.pp-logo__name')).toBeVisible();
  await openPortion(page);
  await expect(page.locator('.pp-portion__status')).toHaveText('Drag to tilt the plate');
  const canvas = page.locator('.pp-portion__css');
  const before = hash(await canvas.screenshot());
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 24, bounds.y + 24, { steps: 8 });
  expect(hash(await canvas.screenshot())).not.toBe(before);
  await page.screenshot({ path: 'test-results/captured-dish-demo.png' });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
});

for (const state of ['loading', 'ready', 'fallback', 'failed'] as const) {
  test(`Figma ${state} state uses exported artwork and preserves Back`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `http://127.0.0.1:5173/?scenario=portion-demo&previewState=${state === 'fallback' ? 'photo' : state}`,
    );
    await openPortion(page);
    await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', state);
    const art =
      state === 'ready'
        ? page.locator('.pp-portion__status')
        : page.locator('.pp-detail__image-wrap');
    if (state !== 'fallback' && state !== 'ready') {
      const style = await art.evaluate((el, pseudo) => {
        const css = getComputedStyle(el, pseudo);
        return { image: css.backgroundImage, width: css.width, height: css.height };
      }, '::after');
      expect(style.image).toMatch(/image\/svg\+xml|\.svg/);
      expect(style.width).toBe(state === 'loading' ? '64px' : '150px');
      expect(style.height).toBe(style.width);
    }
    await page.screenshot({ path: `test-results/figma-portion-${state}.png` });
    if (state === 'failed') {
      const length = await page.evaluate(() => history.length);
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'failed');
      expect(await page.evaluate(() => history.length)).toBe(length);
    }
    await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
  });
}

test('PR25 transient layer failure retries once and recovers', async ({ page }) => {
  await openMenu(page);
  let attempts = 0;
  await page.route('https://assets.example.test/**/1.png', (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          contentType: 'image/png',
          body: images[1]!,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
  });
  await openPortion(page);
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  expect(attempts).toBe(2);
});

test('live reduced-motion preference immediately centers and updates instructions', async ({
  page,
}) => {
  await openMenu(page);
  await openPortion(page);
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  const stage = page.getByRole('group', { name: 'Charred Leeks portion preview' });
  await stage.focus();
  await stage.press('ArrowRight');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.pp-portion__status')).toContainText('Motion is reduced');
  const still = hash(await page.locator('.pp-portion__css').screenshot());
  await stage.press('ArrowRight');
  expect(hash(await page.locator('.pp-portion__css').screenshot())).toBe(still);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.pp-portion__status')).toHaveText('Drag to tilt the plate');
});

test('PR25 interactive cutout fallback stays tiltable without WebGL', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo&previewState=fallback');
  await openPortion(page);
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  const card = page.locator('.pp-portion__css');
  await expect(card).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  const stage = page.getByRole('group', { name: 'Captured dish · tilt demo portion preview' });
  await stage.press('ArrowRight');
  await expect(card).toHaveCSS('transform', /matrix3d/);
  await expect(card).toHaveAttribute('style', /rotateY\(0.5deg\)/);
  await stage.press('Home');
  await expect(card).toHaveAttribute('style', /rotateY\(0deg\)/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stage.press('ArrowRight');
  await expect(card).toHaveAttribute('style', /rotateY\(0deg\)/);
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
});

for (const mode of ['hash', 'dimensions', 'no-photo'] as const) {
  test(`PR25 CSS fallback still rejects invalid assets: ${mode}`, async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: unknown[]) {
        if (kind === 'webgl' || kind === 'webgl2') return null;
        return original.apply(this, [kind, ...args] as Parameters<typeof original>);
      } as typeof original;
    });
    await openMenu(page, mode);
    await openPortion(page);
    await expect(page.locator('.pp-detail')).toHaveAttribute(
      'data-portion-state',
      mode === 'no-photo' ? 'failed' : 'fallback',
    );
    await expect(page.locator('.pp-portion__css')).toHaveCount(0);
  });
}

test('PR25 review appearance and compare/reset controls match the original viewer', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await openPortion(page);
  const stage = page.getByRole('group', { name: 'Captured dish · tilt demo portion preview' });
  const compare = page.getByRole('button', { name: 'Show original photo', exact: true });
  await expect(compare).toBeEnabled();
  const card = page.locator('.pp-portion__css');
  await expect(card).toHaveCSS('background-image', /radial-gradient/);
  const stageBox = (await stage.boundingBox())!;
  const controlBox = (await page.locator('.pp-portion__controls').boundingBox())!;
  expect(stageBox.y - (controlBox.y + controlBox.height)).toBeLessThanOrEqual(20);
  expect(stageBox.width).toBeCloseTo(stageBox.height, 0);
  await stage.press('ArrowRight');
  await expect(card).toHaveAttribute('style', /rotateY\(0.5deg\)/);
  await expect(card.locator('img').last()).toHaveAttribute('style', /translate\(0.833333px, 0px\)/);
  await expect(card).toHaveCSS('transition-duration', '0.3s');
  await compare.click();
  await expect(card).toBeHidden();
  await expect(page.locator('img.pp-detail__image')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show review candidate', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Show review candidate', exact: true }).click();
  await expect(card).toBeVisible();
  await stage.press('ArrowLeft');
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
  await expect(card).toHaveAttribute('style', /rotateY\(0deg\)/);
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(compare).toBeHidden();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
});

test('PR25 touch tracking uses linear motion, release resets and vertical gestures scroll', async ({
  page,
}) => {
  await openMenu(page);
  await openPortion(page);
  const stage = page.locator('.pp-detail__image-wrap');
  const card = page.locator('.pp-portion__css');
  await expect(card).toBeVisible();
  const box = (await stage.boundingBox())!;
  await stage.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 7,
    clientX: box.x + 50,
    clientY: box.y + 100,
  });
  await stage.dispatchEvent('pointermove', {
    pointerType: 'touch',
    pointerId: 7,
    clientX: box.x + 50 + box.width * 0.35,
    clientY: box.y + 100,
  });
  await expect(card).toHaveAttribute('style', /rotateY\(3deg\)/);
  await expect(card.locator('img').last()).toHaveAttribute('style', /translate\(5px, 0px\)/);
  await expect(card).toHaveCSS('transition-timing-function', 'linear');
  await expect(card).toHaveCSS('transition-duration', '0.055s');
  await stage.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7 });
  await expect(card).toHaveAttribute('style', /rotateY\(0deg\)/);
  await expect(card).toHaveCSS('transition-duration', '0.3s');
  await stage.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 8,
    clientX: 100,
    clientY: 100,
  });
  await stage.dispatchEvent('pointermove', {
    pointerType: 'touch',
    pointerId: 8,
    clientX: 102,
    clientY: 160,
  });
  await expect(card).toHaveAttribute('style', /rotateY\(0deg\)/);
  await expect(stage).toHaveCSS('touch-action', 'pan-y');
});

test('PR25 original-photo failure blocks an otherwise valid cutout and comparison', async ({
  page,
}) => {
  await openMenu(page, 'original-missing');
  await openPortion(page);
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'failed');
  await expect(page.locator('.pp-portion__css')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show original photo', exact: true }),
  ).toBeDisabled();
});

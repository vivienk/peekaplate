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
async function openPortion(page: Page, keepPortal = false) {
  if (new URL(page.url()).searchParams.get('scenario') === 'portion-demo') {
    await page.getByRole('button', { name: 'Open Captured dish · tilt demo', exact: true }).click();
  } else {
    await page.locator('.pp-card__open').first().click();
  }
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  const url = new URL(page.url());
  const state = url.searchParams.get('previewState');
  if (
    !keepPortal &&
    url.searchParams.get('scenario') === 'portion-demo' &&
    (!state || state === 'ready' || state === 'fallback')
  ) {
    await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
  }
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
    await expect(page.locator('.pp-detail')).toHaveCSS('background-color', 'rgb(42, 45, 54)');
    await expect(page.locator('.pp-detail__back')).toHaveCSS('width', '42px');
    if (state !== 'ready') await expect(page.locator('.pp-portion__controls')).toBeHidden();
    if (state !== 'fallback') {
      const style = await art.evaluate(
        (el, pseudo) => {
          const css = getComputedStyle(el, pseudo);
          return { image: css.backgroundImage, width: css.width, height: css.height };
        },
        state === 'ready' ? '::before' : '::after',
      );
      expect(style.image).toMatch(/image\/svg\+xml|\.svg/);
      expect(style.width).toBe(state === 'loading' ? '64px' : state === 'ready' ? '46px' : '150px');
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

test('Figma shell retains PR25 movement and expandable compare/reset controls', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await openPortion(page);
  const stage = page.getByRole('group', { name: 'Captured dish · tilt demo portion preview' });
  const compare = page.getByRole('button', { name: 'Show original photo', exact: true });
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  await page.getByText('Preview controls', { exact: true }).click();
  await expect(compare).toBeEnabled();
  const card = page.locator('.pp-portion__css');
  await expect(card).toHaveCSS('background-image', 'none');
  await expect(page.locator('.pp-detail')).toHaveCSS('background-color', 'rgb(42, 45, 54)');
  const stageBox = (await stage.boundingBox())!;
  const controlBox = (await page.locator('.pp-portion__controls').boundingBox())!;
  expect(controlBox.y).toBeGreaterThan(stageBox.y + stageBox.height);
  expect(stageBox.width).toBe(250);
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
    page.getByRole('button', { name: 'Show original photo', exact: true, includeHidden: true }),
  ).toBeDisabled();
  await expect(page.locator('.pp-portion__controls')).toBeHidden();
});

test('local review renders the exact original PNGs and switches without adding history', async ({
  page,
}) => {
  const root = 'frontend/diner/src/menu/fixture-assets/portion-demo/';
  const metadata = JSON.parse(readFileSync(`${root}review-images.json`, 'utf8'));
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await openPortion(page);
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  await page.getByText('Preview controls', { exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Preview image (local review only)' });
  const length = await page.evaluate(() => history.length);
  for (const variant of ['generated', 'cutout', 'generated']) {
    await selector.selectOption(variant);
    await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
    const asset = metadata.variants[variant];
    const rendered = await page.locator('.pp-portion__css img').evaluate(async (element) => {
      const image = element as HTMLImageElement;
      const bytes = await (await fetch(image.src)).arrayBuffer();
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
      };
    });
    expect(rendered).toEqual({ width: asset.width, height: asset.height, sha256: asset.sha256 });
    expect(hash(readFileSync(`${root}${asset.filename}`))).toBe(asset.sha256);
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.screenshot({ path: `test-results/original-${variant}.png` });
  }
  await page.getByRole('button', { name: 'Show original photo', exact: true }).click();
  await expect(page.locator('.pp-portion__css')).toBeHidden();
  await expect(page.locator('img.pp-detail__image')).toBeVisible();
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
});

async function local3d(page: Page, state: string) {
  const metadata = JSON.parse(
    readFileSync('frontend/diner/src/menu/fixture-assets/portion-demo/review-images.json', 'utf8'),
  );
  let saved: string | undefined;
  let creates = 0;
  await page.route('**/__local3d/v1/model-jobs**', async (route) => {
    const req = route.request();
    if (state === 'missing') return route.fulfill({ status: 503, json: {} });
    if (req.method() === 'POST' && !req.url().endsWith('/resume')) {
      saved = req.postDataJSON().job_id;
      creates++;
    }
    if (!saved) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({
      json: {
        job_id: saved,
        status:
          ['resume', 'stale', 'credits'].includes(state) && !req.url().endsWith('/resume')
            ? state === 'stale'
              ? 'waiting'
              : 'prepared'
            : 'ready',
        attempt_status: state === 'stale' ? 'running' : null,
        error_code:
          state === 'credits' && !req.url().endsWith('/resume') ? 'insufficient_credits' : null,
        dish: metadata.dish,
        source: {
          review_asset_id: metadata.source_asset_id,
          variant: 'cutout',
          sha256: metadata.variants.cutout.sha256,
        },
      },
    });
  });
  await page.route('https://ajax.googleapis.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `customElements.define('model-viewer', class extends HTMLElement { connectedCallback() { setTimeout(() => this.dispatchEvent(new Event('load')), 10); } });`,
    }),
  );
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await openPortion(page);
  await page.getByText('Preview controls', { exact: true }).click();
  await page.getByRole('button', { name: 'Generate 3D from cutout', exact: true }).click();
  return () => creates;
}

test('local API unavailable keeps the original interactive 2.5D preview', async ({ page }) => {
  await local3d(page, 'missing');
  await expect(page.locator('.pp-local3d')).toContainText('local Tripo key');
  await expect(page.locator('.pp-portion__css')).toBeVisible();
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
});

test('local 3D ready switches, resets, survives reopen without duplicate create and falls back on viewer error', async ({
  page,
}) => {
  const creates = await local3d(page, 'ready');
  await expect(page.locator('model-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
  expect(
    await page
      .locator('model-viewer')
      .evaluate((el) => (el as HTMLElement & { cameraOrbit: string }).cameraOrbit),
  ).toBe('0deg 75deg 105%');
  await page.getByRole('button', { name: 'Show 2.5D', exact: true }).click();
  await expect(page.locator('.pp-portion__css')).toBeVisible();
  await page.getByRole('button', { name: 'Show 3D', exact: true }).click();
  await expect(page.locator('model-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
  await expect(page.locator('model-viewer')).toHaveCount(0);
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await page.getByRole('button', { name: 'Check 3D job', exact: true }).click();
  await expect(page.locator('model-viewer')).toBeVisible();
  expect(creates()).toBe(1);
  await page.locator('model-viewer').dispatchEvent('error');
  await expect(page.locator('.pp-portion__css')).toBeVisible();
  await expect(page.locator('.pp-local3d')).toContainText('could not load');
});

test('prepared local job resumes explicitly without creating another generation', async ({
  page,
}) => {
  const creates = await local3d(page, 'resume');
  await page.getByRole('button', { name: 'Resume 3D job', exact: true }).click();
  await expect(page.locator('model-viewer')).toBeVisible();
  expect(creates()).toBe(1);
});

test('stale running attempt offers explicit resume after polling deadline', async ({ page }) => {
  await page.clock.install();
  const creates = await local3d(page, 'stale');
  await expect(page.locator('.pp-local3d')).toContainText('Generating 3D');
  await page.clock.fastForward(10 * 60_000 + 3000);
  await page.getByRole('button', { name: 'Resume 3D job', exact: true }).click();
  await expect(page.locator('model-viewer')).toBeVisible();
  expect(creates()).toBe(1);
});

test('zero Tripo credits explain rejection while preserving tilt and explicit same-job resume', async ({
  page,
}) => {
  const creates = await local3d(page, 'credits');
  await expect(page.locator('.pp-local3d')).toContainText('Tripo API credits are insufficient');
  await expect(page.locator('.pp-portion__css')).toBeVisible();
  const stage = page.getByRole('group', {
    name: 'Captured dish · tilt demo portion preview',
    exact: true,
  });
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.pp-portion__css')).not.toHaveCSS('transform', 'none');
  await page.getByRole('button', { name: 'Resume 3D job', exact: true }).click();
  await expect(page.locator('model-viewer')).toBeVisible();
  expect(creates()).toBe(1);
});

async function cameraFixture(page: Page, behavior: 'allow' | 'deny' | 'pending' = 'allow') {
  await page.addInitScript((behavior) => {
    const state = {
      calls: 0,
      stopped: 0,
      resolve: undefined as ((stream: MediaStream) => void) | undefined,
    };
    const fakeCamera = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#8b7766';
      context.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(5);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          state.stopped++;
          stop();
        };
      }
      return stream;
    };
    Object.assign(window, {
      cameraTest: state,
      resolveCamera: () => state.resolve?.(fakeCamera()),
    });
    Object.defineProperty(navigator, 'xr', { configurable: true, value: undefined });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        state.calls++;
        if (behavior === 'deny') throw new DOMException('Denied', 'NotAllowedError');
        if (behavior === 'pending')
          return new Promise<MediaStream>((resolve) => {
            state.resolve = resolve;
          });
        return fakeCamera();
      },
    });
  }, behavior);
}
async function openPortal(page: Page) {
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await openPortion(page, true);
  await expect(page.getByRole('dialog', { name: 'Dish on your table' })).toBeVisible({
    timeout: 20000,
  });
}

test('camera portal positions the exact cutout, rotates, resets and releases camera on Back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await cameraFixture(page);
  await openPortal(page);
  await expect.poll(() => page.evaluate(() => (window as any).cameraTest.calls)).toBe(1);
  await expect(page.locator('.pp-ar__message')).toContainText('Manual camera placement');
  await expect(page.locator('.pp-ar__canvas canvas')).toBeVisible();
  await page.screenshot({ path: 'test-results/ar-camera-mobile.png' });
  await page.getByRole('slider', { name: 'Rotate dish', exact: true }).fill('45');
  await expect(page.getByRole('slider', { name: 'Rotate dish', exact: true })).toHaveValue('45');
  await page.getByRole('button', { name: 'Reposition', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Rotate dish', exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
  await expect(page.locator('.pp-ar')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).cameraTest.stopped)).toBe(1);
  await expect(page.locator('.pp-portion__css')).toBeVisible();
  await expect(page.getByText('Preview controls', { exact: true })).toBeFocused();
});

test('camera denial keeps the portal dismissible and preserves 2.5D and preview history', async ({
  page,
}) => {
  await cameraFixture(page, 'deny');
  await openPortal(page);
  const length = await page.evaluate(() => history.length);
  await expect(page.locator('.pp-ar__message')).toContainText('could not start');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pp-ar')).toHaveCount(0);
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  await expect(page.locator('.pp-portion__css')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length);
});

test('closing portal during camera permission stops a late stream without reviving the portal', async ({
  page,
}) => {
  await cameraFixture(page, 'pending');
  await openPortal(page);
  await expect(page.getByRole('button', { name: 'Reposition', exact: true })).toBeVisible();
  await expect(page.locator('.pp-ar__canvas canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
  await page.evaluate(() => (window as any).resolveCamera());
  await expect.poll(() => page.evaluate(() => (window as any).cameraTest.stopped)).toBe(1);
  await expect(page.locator('.pp-ar')).toHaveCount(0);
  await expect(page.locator('.pp-portion__css')).toBeVisible();
});

function portalTestGLB(textured = false) {
  const png = textured
    ? readFileSync('frontend/diner/src/menu/fixture-assets/portion-demo/cutout.png')
    : Buffer.alloc(0);
  const geometryLength = textured ? 60 : 36;
  const binary = Buffer.alloc(geometryLength + png.length + ((4 - (png.length % 4)) % 4));
  if (textured) {
    [0, 0, 1, 0, 0.5, 1].forEach((value, i) => binary.writeFloatLE(value, 36 + i * 4));
    png.copy(binary, 60);
  }
  [-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0].forEach((value, i) => binary.writeFloatLE(value, i * 4));
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, ...(textured ? { TEXCOORD_0: 1 } : {}) },
            ...(textured ? { material: 0 } : {}),
          },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-0.5, 0, 0],
        max: [0.5, 1, 0],
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      ...(textured
        ? [
            { buffer: 0, byteOffset: 36, byteLength: 24 },
            { buffer: 0, byteOffset: 60, byteLength: png.length },
          ]
        : []),
    ],
    buffers: [{ byteLength: binary.length }],
    ...(textured
      ? {
          images: [{ bufferView: 2, mimeType: 'image/png' }],
          textures: [{ source: 0 }],
          materials: [
            {
              pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
              alphaMode: 'BLEND',
              doubleSided: true,
            },
          ],
        }
      : {}),
  };
  if (textured)
    doc.accessors.push({
      bufferView: 1,
      componentType: 5126,
      count: 3,
      type: 'VEC2',
      min: [0, 0],
      max: [1, 1],
    });
  let json = JSON.stringify(doc);
  json += ' '.repeat((4 - (json.length % 4)) % 4);
  const result = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  result.write('glTF');
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  result.write(json, 20);
  const offset = 20 + json.length;
  result.writeUInt32LE(binary.length, offset);
  result.writeUInt32LE(0x004e4942, offset + 4);
  binary.copy(result, offset + 8);
  return result;
}

for (const fail of [false, true]) {
  test(`camera portal loads a real GLB and retains 2.5D when model fails=${fail}`, async ({
    page,
  }) => {
    await cameraFixture(page);
    await local3d(page, 'ready');
    await expect(page.locator('model-viewer')).toBeVisible();
    await page.route('**/artifacts/model.glb', (route) =>
      route.fulfill({
        status: fail ? 404 : 200,
        contentType: 'model/gltf-binary',
        body: fail ? Buffer.from('missing') : portalTestGLB(),
      }),
    );
    await page.getByRole('button', { name: 'View on your table', exact: true }).click();
    if (fail) {
      await expect(
        page.getByRole('button', { name: '3D unavailable · showing 2.5D', exact: true }),
      ).toBeDisabled();
    } else {
      await page.getByRole('button', { name: 'Show 3D', exact: true }).click();
      await expect(page.locator('.pp-ar')).toHaveAttribute('data-visual', '3d');
      await page.getByRole('slider', { name: 'Rotate dish', exact: true }).fill('60');
      await page
        .getByRole('dialog', { name: 'Dish on your table' })
        .getByRole('button', { name: 'Show 2.5D', exact: true })
        .click();
    }
    await expect(page.locator('.pp-ar')).toHaveAttribute('data-visual', '2.5d');
    await page.screenshot({ path: `test-results/ar-camera-${fail ? 'fallback' : 'switch'}.png` });
    await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
    expect(await page.evaluate(() => (window as any).cameraTest.stopped)).toBe(2);
  });
}

test('unavailable table session falls back to manual camera and browser Back stops the stream', async ({
  page,
}) => {
  await cameraFixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: {
        isSessionSupported: async () => true,
        requestSession: async (_mode: string, options: unknown) => {
          Object.assign(window, { xrRequested: options });
          throw new DOMException('Unsupported features', 'NotSupportedError');
        },
      },
    });
  });
  await openPortal(page);
  await page.getByRole('button', { name: 'Start table AR', exact: true }).click();
  expect(await page.evaluate(() => (window as any).xrRequested.requiredFeatures)).toEqual([
    'hit-test',
    'dom-overlay',
  ]);
  await page.getByRole('button', { name: 'Try camera preview', exact: true }).click();
  await page.goBack();
  await expect(page.locator('.pp-ar')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).cameraTest.stopped)).toBe(2);
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeVisible();
});

for (const late of [false, true]) {
  test(`portal closes owned textured-model bitmaps on ${late ? 'late load' : 'dismissal'}`, async ({
    page,
  }) => {
    await cameraFixture(page);
    await page.addInitScript((late) => {
      const original = window.createImageBitmap.bind(window);
      const state = { created: 0, closed: 0, release: undefined as (() => void) | undefined };
      Object.assign(window, { bitmapTest: state });
      window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
        const bitmap = await original(...args);
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => {
          state.closed++;
          close();
        };
        state.created++;
        if (late)
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
        return bitmap;
      }) as typeof createImageBitmap;
    }, late);
    await local3d(page, 'ready');
    await expect(page.locator('model-viewer')).toBeVisible();
    await page.route('**/artifacts/model.glb', (route) =>
      route.fulfill({ contentType: 'model/gltf-binary', body: portalTestGLB(true) }),
    );
    await page.getByRole('button', { name: 'View on your table', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).bitmapTest.created)).toBe(1);
    if (!late)
      await expect(
        page.getByRole('dialog').getByRole('button', { name: 'Show 3D', exact: true }),
      ).toBeEnabled();
    await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
    if (late) await page.evaluate(() => (window as any).bitmapTest.release());
    await expect.poll(() => page.evaluate(() => (window as any).bitmapTest.closed)).toBe(1);
    await page.getByRole('button', { name: 'Show 2.5D', exact: true }).click();
    await expect(page.locator('.pp-portion__css')).toBeVisible();
  });
}

test('2.5D opens the camera portal automatically and Back keeps the preview usable', async ({
  page,
}) => {
  await cameraFixture(page);
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await openPortion(page, true);
  await expect(page.getByRole('dialog', { name: 'Dish on your table' })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole('button', { name: 'Reposition', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place dish', exact: true })).toBeHidden();
  await page.screenshot({ path: 'test-results/automatic-ar-portal.png' });
  await expect.poll(() => page.evaluate(() => (window as any).cameraTest.calls)).toBe(1);
  await expect(page.locator('.pp-ar__message')).toContainText('Manual camera placement');
  await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Preview controls', { exact: true })).toBeFocused();
  await expect(page.locator('.pp-portion__css img')).toBeVisible();
  await page.getByText('Preview controls', { exact: true }).click();
  await page.getByLabel('Preview image (local review only)').selectOption('cutout');
  await expect(page.locator('.pp-portion__css img')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('camera demo retains the full diner menu and PR145 icons', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/?scenario=portion-demo');
  await expect(page.getByRole('heading', { name: 'Ember & Stone', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.pp-card__open').count()).toBeGreaterThan(1);
  await expect(page.locator('.pp-search__icon')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Avocado Toast', exact: true })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save Avocado Toast', exact: true });
  await save.click();
  await expect(save).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.pp-saved').click();
  await expect(page.getByRole('heading', { name: 'Saved Dishes', exact: true })).toBeVisible();
  await expect(page.locator('.pp-saved__item')).toContainText('Avocado Toast');
  await page.getByRole('button', { name: 'Back to menu', exact: true }).click();
  await page.getByRole('button', { name: 'Open Captured dish · tilt demo', exact: true }).click();
  await expect(page.locator('.pp-detail__back-icon')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeEnabled();
});

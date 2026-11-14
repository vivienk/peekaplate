import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const base = 'http://127.0.0.1:5186';
const bundle = JSON.parse(
  readFileSync('packages/contracts/fixtures/public-menu-bundle.v1/bundle.json', 'utf8'),
);
const scope = { venueId: bundle.venue_id, menuId: bundle.menu_id };
const directory = { schemaVersion: 1, restaurants: [{ slug: 'noka_ramen', ...scope }] };

async function arrange(page: Page, state: 'published' | 'withdrawn' | 'tampered' = 'published') {
  const publicReads: string[] = [];
  await page.route('**/restaurant-links.json', (route) => route.fulfill({ json: directory }));
  await page.route('**/public/venues/**', (route) => {
    publicReads.push(route.request().url());
    return route.fulfill(
      state === 'withdrawn'
        ? { status: 404, json: { error: 'not_found' } }
        : {
            json: {
              schemaVersion: 1,
              ...scope,
              menuRevisionId: bundle.menu_revision_id,
              publicationId: '44444444-4444-4444-8444-444444444444',
              publicationHash: 'a'.repeat(64),
              availabilityVersion: 1,
              tier: 'T0',
              bundle: {
                url: 'https://bundle.example.test/menu.json',
                contentHash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
                assetManifestHash: 'b'.repeat(64),
              },
              menuToken: 'synthetic-local-test-token',
              tokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            },
          },
    );
  });
  await page.route('https://bundle.example.test/menu.json', (route) =>
    route.fulfill({
      json:
        state === 'tampered'
          ? { ...bundle, restaurant: { ...bundle.restaurant, name: 'Unapproved text' } }
          : bundle,
    }),
  );
  await page.route('https://assets.example.test/**', (route) => route.abort());
  return publicReads;
}

test('root and reserved owner path do not become a diner fallback', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  expect((await page.goto(`${base}/`))?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect((await page.goto(`${base}/owner/`))?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect(requests.every((url) => !url.includes('/diner/'))).toBe(true);
});

test('restaurant link loads the built app, CSS and chunks, and survives refresh', async ({
  page,
}) => {
  const publicReads = await arrange(page);
  const errors: string[] = [];
  const assets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (/\/diner\/assets\/.*\.(?:css|js)$/.test(response.url())) {
      expect(response.status()).toBe(200);
      assets.push(response.url());
    }
  });
  const path = `${base}/diner/noka_ramen?venueId=ignored&menuToken=ignored`;
  await page.goto(path);
  expect(page.url()).toBe(path);
  await expect(
    page.getByRole('heading', { name: bundle.restaurant.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: bundle.restaurant.name, exact: true }),
  ).toBeVisible();
  expect(publicReads).toEqual(
    Array(2).fill(`${base}/public/venues/${scope.venueId}/menus/${scope.menuId}`),
  );
  expect(assets.some((url) => url.endsWith('.css'))).toBe(true);
  expect(assets.some((url) => url.endsWith('.js'))).toBe(true);
  expect(errors).toEqual([]);
  expect(page.url()).toBe(path);
});

test('prefixed canonical QR link works without reading the alias directory', async ({ page }) => {
  await arrange(page);
  await page.route('**/restaurant-links.json', (route) => route.abort());
  await page.goto(`${base}/diner/venues/${scope.venueId}/menus/${scope.menuId}`);
  await expect(
    page.getByRole('heading', { name: bundle.restaurant.name, exact: true }),
  ).toBeVisible();
});

test('trailing-slash restaurant link also reaches the same published menu', async ({ page }) => {
  await arrange(page);
  await page.goto(`${base}/diner/noka_ramen/`);
  await expect(
    page.getByRole('heading', { name: bundle.restaurant.name, exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/diner/noka_ramen/');
});

test('unknown restaurant does not fetch a menu or fall back to fictional dishes', async ({
  page,
}) => {
  const reads = await arrange(page);
  await page.goto(`${base}/diner/unknown`);
  await expect(page.locator('.pp-state-text')).toHaveText('This menu is unavailable right now.');
  expect(reads).toEqual([]);
  await expect(page.locator('.pp-card__open')).toHaveCount(0);
});

for (const state of ['withdrawn', 'tampered'] as const)
  test(`${state} menu stays closed through restaurant link`, async ({ page }) => {
    await arrange(page, state);
    await page.goto(`${base}/diner/noka_ramen`);
    await expect(page.locator('.pp-state-text')).toHaveText(
      state === 'withdrawn'
        ? 'This menu is unavailable right now.'
        : 'We could not load the menu. Please try again.',
    );
    await expect(page.locator('.pp-card__open')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: bundle.restaurant.name, exact: true }),
    ).toHaveCount(0);
  });

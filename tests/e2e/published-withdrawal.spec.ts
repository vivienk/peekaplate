import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// S5-FE-10 stale/withdrawn menu. Real diner loader, verifier and refresher with synthetic HTTP
// responses; no hosted acceptance is claimed. Interim copy: "This menu is no longer available."
const content = JSON.parse(
  readFileSync('packages/contracts/fixtures/public-menu-bundle.v1/bundle.json', 'utf8'),
);
const bytes = JSON.stringify(content);
const digest = createHash('sha256').update(bytes).digest('hex');
const routePath = `/venues/${content.venue_id}/menus/${content.menu_id}`;
const FIRST = '44444444-4444-4444-8444-444444444444';
const SECOND = '55555555-5555-4555-8555-555555555555';

type Kind = 'valid' | 'replaced' | 'withdrawn' | 'error';
type State = { kind: Kind };

async function open(page: Page, state: State) {
  await page.clock.install();
  await page.route('**/src/menu/menuScreen.ts*', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replaceAll('import.meta.env.VITE_MENU_SOURCE', '"live"')
      .replaceAll('import.meta.env.VITE_PUBLIC_API_URL', '"http://127.0.0.1:5173"');
    await route.fulfill({ response, body });
  });
  await page.route('**/public/venues/**', async (route) => {
    if (state.kind === 'withdrawn')
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    if (state.kind === 'error')
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        venueId: content.venue_id,
        menuId: content.menu_id,
        menuRevisionId: content.menu_revision_id,
        publicationId: state.kind === 'replaced' ? SECOND : FIRST,
        publicationHash: 'a'.repeat(64),
        availabilityVersion: 1,
        tier: 'T0',
        bundle: {
          url: 'https://bundle.example.test/bundle.json',
          contentHash: digest,
          assetManifestHash: 'b'.repeat(64),
        },
        menuToken: 'synthetic-not-signed',
        tokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    });
  });
  await page.route('https://bundle.example.test/bundle.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: bytes }),
  );
  await page.route('https://assets.example.test/**', (route) => route.abort());
  await page.goto(`http://127.0.0.1:5173${routePath}`);
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
}

// The re-read starts 5 minutes before the 30-minute token expires.
const reread = (page: Page) => page.clock.fastForward(25 * 60_000 + 1000);
const gone = (page: Page) => page.getByText('This menu is no longer available.', { exact: false });

test('a 404 on the re-read removes the old menu, explains it and offers Check again', async ({
  page,
}) => {
  const state: State = { kind: 'valid' };
  await open(page, state);
  state.kind = 'withdrawn';
  await reread(page);

  await expect(gone(page)).toBeVisible();
  await expect(page.locator('.pp-card__open')).toHaveCount(0);
  await expect(page.locator('.pp-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  // Focus moves to the explanation (the focused card was removed), then Tab reaches the button.
  await expect(page.locator('.pp-state-text')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Check again' })).toBeFocused();
});

test('an open dish detail is also removed when the menu is withdrawn', async ({ page }) => {
  const state: State = { kind: 'valid' };
  await open(page, state);
  await page.locator('.pp-card__open').first().click();
  await expect(page.locator('.pp-detail__back')).toBeVisible();
  state.kind = 'withdrawn';
  await reread(page);

  await expect(gone(page)).toBeVisible();
  await expect(page.locator('.pp-detail__back')).toHaveCount(0);
});

test('Check again while still withdrawn keeps the explanation and the button', async ({ page }) => {
  const state: State = { kind: 'valid' };
  await open(page, state);
  state.kind = 'withdrawn';
  await reread(page);
  await page.getByRole('button', { name: 'Check again' }).click();

  await expect(gone(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.locator('.pp-card__open')).toHaveCount(0);
});

test('Check again after a fresh publication loads the latest menu and counts one new menu_viewed', async ({
  page,
}) => {
  const state: State = { kind: 'valid' };
  await open(page, state);
  await page.evaluate(async () => {
    const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
    const captured: string[] = [];
    Object.assign(window, { reviewCaptured: captured });
    tracking.connectPostHog({
      capturePostHog: (type: string) => captured.push(type),
      setConsent: () => {},
    });
    tracking.setTrackingAllowed(true);
  });
  const menuViews = () =>
    page.evaluate(
      () => (window as any).reviewCaptured.filter((type: string) => type === 'menu_viewed').length,
    );
  expect(await menuViews()).toBe(1);

  state.kind = 'withdrawn';
  await reread(page);
  await expect(gone(page)).toBeVisible();
  // The owner publishes a replacement; the visitor presses Check again.
  state.kind = 'replaced';
  await page.getByRole('button', { name: 'Check again' }).click();

  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await expect(gone(page)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: content.restaurant.name, exact: true }),
  ).toBeFocused();
  // A different publication counts as one new view, never a duplicate for the same one.
  expect(await menuViews()).toBe(2);
});

test('a transient server error keeps the menu and never shows the withdrawn state', async ({
  page,
}) => {
  const state: State = { kind: 'valid' };
  await open(page, state);
  state.kind = 'error';
  await reread(page);
  await page.clock.runFor(3 * 60_000);

  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await expect(gone(page)).toHaveCount(0);
});

test('a replaced menu swaps in the new revision and is not shown as withdrawn', async ({
  page,
}) => {
  const state: State = { kind: 'valid' };
  await open(page, state);
  state.kind = 'replaced';
  await reread(page);

  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await expect(gone(page)).toHaveCount(0);
});

test('the withdrawn state works at 390px, passes axe and has no sideways scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state: State = { kind: 'valid' };
  await open(page, state);
  state.kind = 'withdrawn';
  await reread(page);
  await expect(gone(page)).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

// Real diner loader/verifier/refresh with synthetic HTTP responses; no hosted acceptance claim.
const content = JSON.parse(
  readFileSync('packages/contracts/fixtures/public-menu-bundle.v1/bundle.json', 'utf8'),
);
const bytes = JSON.stringify(content);
const digest = createHash('sha256').update(bytes).digest('hex');
const publication = '44444444-4444-4444-8444-444444444444';
const routePath = `/venues/${content.venue_id}/menus/${content.menu_id}`;

async function open(page: Page, state: { kind: 'valid' | 'tampered' | 'withdrawn' }) {
  await page.clock.install();
  await page.route('**/src/menu/menuScreen.ts*', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replaceAll('import.meta.env.VITE_MENU_SOURCE', '"live"')
      .replaceAll('import.meta.env.VITE_PUBLIC_API_URL', '"http://127.0.0.1:5173"');
    await route.fulfill({ response, body });
  });
  // HTTPS is required by the shared delivery contract.
  await page.route('**/public/venues/**', async (route) => {
    if (state.kind === 'withdrawn')
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        venueId: content.venue_id,
        menuId: content.menu_id,
        menuRevisionId: content.menu_revision_id,
        publicationId: publication,
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
    route.fulfill({
      contentType: 'application/json',
      body: state.kind === 'tampered' ? `${bytes}\n` : bytes,
    }),
  );
  await page.route('https://assets.example.test/**', (route) => route.abort());
  await page.goto('http://127.0.0.1:5173' + routePath);
}

test('the real verifier accepts exact bytes and displays approved content', async ({ page }) => {
  await open(page, { kind: 'valid' });
  await expect(
    page.getByRole('heading', { name: content.restaurant.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await expect(page.getByText('Fixture data', { exact: true })).toHaveCount(0);
});

test('tampered bytes never render dish content', async ({ page }) => {
  await open(page, { kind: 'tampered' });
  await expect(page.getByText('We could not load the menu. Please try again.')).toBeVisible();
  await expect(page.locator('.pp-card__open')).toHaveCount(0);
});

test('a fresh withdrawn menu is unavailable', async ({ page }) => {
  await open(page, { kind: 'withdrawn' });
  await expect(page.getByText('This menu is unavailable right now.')).toBeVisible();
});

test('active withdrawal preserves browsing but stops both destinations', async ({ page }) => {
  const state = { kind: 'valid' as 'valid' | 'tampered' | 'withdrawn' };
  await open(page, state);
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await page.evaluate(async () => {
    const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
    // Record event types: the real screen also sends its own dish_viewed events.
    const sent: string[] = [];
    const captured: string[] = [];
    Object.assign(window, { reviewSent: sent, reviewCaptured: captured });
    tracking.connectPostHog({
      capturePostHog: (type: string) => captured.push(type),
      setConsent: () => {},
    });
    tracking.enableLiveTracking(async (batch: { event_id: string; type: string }[]) => {
      sent.push(...batch.map((e) => e.type));
      return batch.map((e) => e.event_id);
    });
    tracking.setTrackingAllowed(true);
  });
  const countOf = (type: string) =>
    page.evaluate(
      (type) => (window as any).reviewSent.filter((t: string) => t === type).length,
      type,
    );
  await page.evaluate(async (publicationId) => {
    const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
    tracking.track('menu_viewed', { publication_revision_id: publicationId, entry_source: 'qr' });
  }, publication);
  await page.clock.runFor(6000);
  await expect.poll(() => countOf('menu_viewed')).toBe(1);
  state.kind = 'withdrawn';
  await page.clock.fastForward(25 * 60_000 + 1000);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await import(/* @vite-ignore */ '/src/tracking/index.ts')).isLiveTracking(),
      ),
    )
    .toBe(false);
  // Whatever was delivered before withdrawal; nothing of any type may follow it.
  const sentAtWithdrawal = await page.evaluate(() => (window as any).reviewSent.length);
  const capturedAtWithdrawal = await page.evaluate(() => (window as any).reviewCaptured.length);
  await page.evaluate(async (publicationId) => {
    const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
    tracking.track('menu_viewed', { publication_revision_id: publicationId, entry_source: 'qr' });
  }, publication);
  await page.clock.runFor(6000);
  const recorded = await page.evaluate(() => ({
    sent: (window as any).reviewSent as string[],
    captured: (window as any).reviewCaptured as string[],
  }));
  expect(recorded.sent.filter((type) => type === 'menu_viewed')).toHaveLength(1);
  expect(recorded.captured.filter((type) => type === 'menu_viewed')).toHaveLength(1);
  expect(recorded.sent).toHaveLength(sentAtWithdrawal);
  expect(recorded.captured).toHaveLength(capturedAtWithdrawal);
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
});

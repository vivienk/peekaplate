import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

// Real screen, verifier and shared tracking; synthetic HTTP and in-memory destination sinks.
// These checks establish browser integration, not hosted provider/Queue acceptance.
const original = JSON.parse(
  readFileSync('packages/contracts/fixtures/public-menu-bundle.v1/bundle.json', 'utf8'),
);
const publicationA = '44444444-4444-4444-8444-444444444444';
const publicationB = '44444444-4444-4444-8444-444444444445';
type Event = { type: string; publication_revision_id?: string; payload: Record<string, unknown> };
type Captures = { captured: Event[]; delivered: Event[] };

async function open(page: Page) {
  const state = { publication: publicationA, bundle: structuredClone(original) };
  await page.clock.install({ time: new Date('2026-11-11T10:00:00Z') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/src/menu/menuScreen.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text())
        .replaceAll('import.meta.env.VITE_MENU_SOURCE', '"live"')
        .replaceAll('import.meta.env.VITE_PUBLIC_API_URL', '"http://127.0.0.1:5173"'),
    });
  });
  await page.route('**/public/venues/**', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        venueId: state.bundle.venue_id,
        menuId: state.bundle.menu_id,
        menuRevisionId: state.bundle.menu_revision_id,
        publicationId: state.publication,
        publicationHash: 'a'.repeat(64),
        availabilityVersion: 1,
        tier: 'T0',
        bundle: {
          url: 'https://bundle.example.test/bundle.json',
          contentHash: createHash('sha256').update(JSON.stringify(state.bundle)).digest('hex'),
          assetManifestHash: 'b'.repeat(64),
        },
        menuToken: 'synthetic-not-signed',
        tokenExpiresAt: new Date(
          (await page.evaluate(() => Date.now())) + 30 * 60_000,
        ).toISOString(),
      }),
    }),
  );
  await page.route('https://bundle.example.test/bundle.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.bundle) }),
  );
  await page.route('https://assets.example.test/**', (route) => route.abort());
  await page.goto(`http://127.0.0.1:5173/venues/${original.venue_id}/menus/${original.menu_id}`);
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await page.clock.pauseAt(new Date('2026-11-11T10:00:05Z'));
  await page.evaluate(async () => {
    const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
    const captures: Captures = { captured: [], delivered: [] };
    Object.assign(window, { triggerCaptures: captures });
    tracking.connectPostHog({
      capturePostHog: (type: string, payload: Record<string, unknown>) =>
        captures.captured.push({ type, payload }),
      setConsent: () => {},
    });
    tracking.enableLiveTracking(async (batch: (Event & { event_id: string })[]) => {
      captures.delivered.push(...batch);
      return batch.map((event) => event.event_id);
    });
  });
  return state;
}

const consent = (page: Page, value: boolean) =>
  page.evaluate(async (value) => {
    (await import(/* @vite-ignore */ '/src/tracking/index.ts')).setTrackingAllowed(value);
  }, value);

const captured = (page: Page, type: string) =>
  page.evaluate(
    (type) =>
      (window as unknown as { triggerCaptures: Captures }).triggerCaptures.captured.filter(
        (event) => event.type === type,
      ),
    type,
  );

test('opting in on an open detail starts a new opening without preconsent time', async ({
  page,
}) => {
  await open(page);
  await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
  await page.clock.runFor(12_000);
  expect(await captured(page, 'dish_activity_checkpoint')).toEqual([]);
  await consent(page, true);
  await page.clock.runFor(6000);
  const openings = await captured(page, 'dish_detail_opened');
  expect(openings).toHaveLength(1);
  const checkpoints = await captured(page, 'dish_activity_checkpoint');
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]?.payload).toMatchObject({
    opening_id: openings[0]?.payload.opening_id,
    active_ms: 5000,
    final: false,
  });
  await page.clock.runFor(5000);
  const deliveries = await page.evaluate(
    () => (window as unknown as { triggerCaptures: Captures }).triggerCaptures.delivered,
  );
  expect(deliveries.some((event) => event.type === 'dish_detail_opened')).toBe(true);
});

test('withdrawal discards detail timing and reconsent starts a fresh opening', async ({ page }) => {
  await open(page);
  await consent(page, true);
  await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
  await page.clock.runFor(10_000);
  await consent(page, false);
  const before = await captured(page, 'dish_activity_checkpoint');
  await page.clock.runFor(12_000);
  expect(await captured(page, 'dish_activity_checkpoint')).toEqual(before);
  await consent(page, true);
  await page.clock.runFor(6000);
  const openings = await captured(page, 'dish_detail_opened');
  expect(openings).toHaveLength(2);
  expect(openings[1]?.payload.opening_id).not.toBe(openings[0]?.payload.opening_id);
  expect((await captured(page, 'dish_activity_checkpoint')).at(-1)?.payload).toMatchObject({
    opening_id: openings[1]?.payload.opening_id,
    active_ms: 5000,
  });
});

test('an opening after opt-in never links a dropped preconsent exposure', async ({ page }) => {
  await open(page);
  await page.clock.runFor(2000);
  await consent(page, true);
  await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
  const openings = await captured(page, 'dish_detail_opened');
  expect(openings).toHaveLength(1);
  expect(openings[0]?.payload).not.toHaveProperty('from_exposure_id');
  expect(await captured(page, 'dish_viewed')).toEqual([]);
});

test('a readable replacement records its menu once and cannot reuse the old exposure', async ({
  page,
}) => {
  const state = await open(page);
  await consent(page, true);
  await page.locator('.pp-category:not([hidden]) .pp-card').first().scrollIntoViewIfNeeded();
  // Re-observe after consent so the test starts from a recorded, eligible exposure.
  await page.evaluate(() => document.dispatchEvent(new globalThis.Event('visibilitychange')));
  await page.waitForTimeout(100);
  await page.clock.runFor(2000);
  expect((await captured(page, 'dish_viewed')).length).toBeGreaterThan(0);
  state.publication = publicationB;
  state.bundle.menu_revision_id = '00000000-0000-4000-8000-000000000203';
  state.bundle.categories[0].dishes[0].dish_revision_id = '00000000-0000-4000-8000-000000000221';
  state.bundle.restaurant.name = 'Replacement Synthetic Bistro';
  await page.clock.fastForward(25 * 60_000);
  await expect(
    page.getByRole('heading', { name: state.bundle.restaurant.name, exact: true }),
  ).toBeVisible();
  await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
  const opening = (await captured(page, 'dish_detail_opened')).at(-1);
  expect(opening?.payload).not.toHaveProperty('from_exposure_id');
  await page.clock.runFor(6000);
  const deliveries = await page.evaluate(
    () => (window as unknown as { triggerCaptures: Captures }).triggerCaptures.delivered,
  );
  expect(
    deliveries.filter(
      (event) => event.type === 'menu_viewed' && event.publication_revision_id === publicationB,
    ),
  ).toHaveLength(1);
  await page.locator('.pp-detail__back').click();
  await page.waitForTimeout(100);
  await page.clock.runFor(1500);
  await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
  const linked = (await captured(page, 'dish_detail_opened')).at(-1);
  const exposure = (await captured(page, 'dish_viewed')).find(
    (event) => event.payload.exposure_id === linked?.payload.from_exposure_id,
  );
  expect(exposure).toBeDefined();
  expect(exposure?.payload.dish_revision_id).toBe(linked?.payload.dish_revision_id);
  await page.clock.runFor(6000);
  expect(
    await page.evaluate(
      (publication) =>
        (window as unknown as { triggerCaptures: Captures }).triggerCaptures.delivered.filter(
          (event) => event.type === 'menu_viewed' && event.publication_revision_id === publication,
        ).length,
      publicationB,
    ),
  ).toBe(1);
});

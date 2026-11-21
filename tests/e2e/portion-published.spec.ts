import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

// Production bundle, demos disabled, real verifier and synthetic published capture layers.
test('production tracks the first menu view and portions without a prompt, with camera and GPC guards', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Expected a local built diner server');
  const dinerOrigin = 'https://diner.peekaplate.app';
  await context.route(`${dinerOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    await route.fulfill({ response });
  });
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const images = [
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#eee"/></svg>',
    ),
    readFileSync('tests/fixtures/portion/foreground.png'),
  ];
  const content = JSON.parse(
    readFileSync('packages/contracts/fixtures/public-menu-bundle.v1/bundle.json', 'utf8'),
  );
  const dish = content.categories[0].dishes[0];
  dish.portion = {
    schema_version: 1,
    dish_id: dish.dish_id,
    dish_revision_id: dish.dish_revision_id,
    width: 64,
    height: 64,
    layers: images.map((bytes, depth) => ({
      url: `https://assets.example.test/public/prepared-assets/${content.venue_id}/55555555-5555-4555-8555-555555555555/${hash(bytes)}`,
      sha256: hash(bytes),
      size_bytes: bytes.length,
      depth,
    })),
  };
  const bytes = JSON.stringify(content);
  const publicationId = '44444444-4444-4444-8444-444444444444';
  await context.route('https://api.example.test/public/restaurants/portion-qa', (route) =>
    route.fulfill({ json: { venueId: content.venue_id, menuId: content.menu_id } }),
  );
  const captures: Record<string, unknown>[] = [];
  const views: Record<string, unknown>[] = [];
  await context.route('https://us.i.posthog.com/**', (route) => {
    const raw = route.request().postDataBuffer();
    if (raw) {
      const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
      const { batch } = JSON.parse(bytes.toString()) as {
        batch: { event: string; properties: Record<string, unknown> }[];
      };
      for (const capture of batch) {
        if (capture.event === 'menu_viewed') views.push(capture.properties);
        if (capture.event === 'dish_portion_opened') captures.push(capture.properties);
      }
    }
    return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {} });
  });
  const observations: {
    event_id: string;
    type: string;
    publication_revision_id: string;
    payload: unknown;
  }[] = [];
  const menuEvents = () => observations.filter((event) => event.type === 'menu_viewed');
  const portionEvents = () => observations.filter((event) => event.type === 'dish_portion_opened');
  await context.route('https://api.example.test/observations', (route) => {
    const { events } = route.request().postDataJSON() as { events: typeof observations };
    observations.push(...events);
    return route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: {
        contract: 'observation-receipt.v1',
        request_id: crypto.randomUUID(),
        receipts: events.map(({ event_id }) => ({
          event_id,
          status: 'accepted',
          reason_code: null,
          retryable: false,
        })),
      },
    });
  });
  await context.route('https://api.example.test/public/venues/**', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        venueId: content.venue_id,
        menuId: content.menu_id,
        menuRevisionId: content.menu_revision_id,
        publicationId,
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
  await context.route('https://bundle.example.test/portion.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: bytes }),
  );
  await context.route('https://assets.example.test/t0_*/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: images[1] }),
  );
  let failLayers = false;
  await context.route('https://assets.example.test/public/prepared-assets/**', (route) => {
    if (failLayers) return route.fulfill({ status: 404 });
    const layer = images.findIndex((image) =>
      route
        .request()
        .url()
        .endsWith(`/${hash(image)}`),
    );
    if (layer < 0) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: layer === 0 ? 'image/svg+xml' : 'image/png',
      body: images[layer],
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
  await context.addInitScript(() => {
    // The pinned PostHog SDK drops automation traffic by default.
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
    Object.assign(window, { cameraRequests: 0 });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        (window as any).cameraRequests++;
        return new Promise((_resolve, reject) => {
          (window as any).denyCamera = () =>
            reject(new DOMException('Synthetic denial', 'NotAllowedError'));
        });
      },
    });
  });
  const cameraChunks: string[] = [];
  page.on('request', (request) => {
    if (/\/(?:portionAR|three)[^/]*\.js/.test(request.url())) cameraChunks.push(request.url());
  });
  const evidence = 'outputs/duplication-wiring-evidence';
  mkdirSync(evidence, { recursive: true });
  const snapshot = (name: string) =>
    page.screenshot({
      path: `${evidence}/published-portion-${testInfo.project.name}-${name}.png`,
      fullPage: !name.startsWith('camera'),
    });
  await page.goto(`${dinerOrigin}/diner/portion-qa?test_private=hidden`);
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
  await expect(page.locator('#consent')).toHaveCount(0);
  await expect.poll(() => menuEvents().length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => views.length).toBe(1);
  expect(views[0]).toMatchObject({
    environment: 'production',
    event_id: menuEvents()[0]?.event_id,
    venue_id: content.venue_id,
    publication_revision_id: publicationId,
    distinct_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  await snapshot('menu');
  await page.locator('.pp-card__open').first().click();
  await snapshot('detail');
  expect(cameraChunks).toEqual([]);
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  await expect.poll(() => portionEvents().length, { timeout: 10_000 }).toBe(1);
  expect(portionEvents()[0]).toMatchObject({
    publication_revision_id: publicationId,
    payload: { dish_id: dish.dish_id, dish_revision_id: dish.dish_revision_id },
  });
  await expect.poll(() => captures.length).toBe(1);
  expect(captures[0]).toMatchObject({
    environment: 'production',
    event_id: portionEvents()[0]?.event_id,
    venue_id: content.venue_id,
    publication_revision_id: publicationId,
    dish_id: dish.dish_id,
    dish_revision_id: dish.dish_revision_id,
  });
  expect(JSON.stringify(captures[0])).not.toMatch(/test_private|portion-qa|synthetic-only/);
  for (const privateKey of ['$current_url', '$pathname', '$referrer', 'session_id', 'producer_id'])
    expect(captures[0]).not.toHaveProperty(privateKey);
  await page.getByText('Preview controls', { exact: true }).click();
  const entry = page.getByRole('button', { name: 'View on your table', exact: true });
  await expect(entry).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(cameraChunks).toEqual([]);
  expect(await page.evaluate(() => (window as any).cameraRequests)).toBe(0);
  await snapshot('preview');
  await entry.click();
  const portal = page.getByRole('dialog', { name: 'Dish on your table', exact: true });
  await expect(portal).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).cameraRequests)).toBe(1);
  await expect(portal.locator('.pp-ar__scale-status')).toContainText(
    'Approximate preview · matching serving/plate measurements not supplied',
  );
  expect(cameraChunks.length).toBeGreaterThan(0);
  await snapshot('camera');
  await page.evaluate(() => (window as any).denyCamera());
  await portal.getByText('Adjust view', { exact: true }).click();
  await expect(portal.locator('.pp-ar__message')).toContainText('Camera');
  await snapshot('camera-denied');
  await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
  await expect(entry).toBeFocused();
  await expect(page.locator('.pp-portion__css')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'View Portion', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  failLayers = true;
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'fallback');
  await page.keyboard.press('Escape');
  failLayers = false;
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(page.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  await expect.poll(() => portionEvents().length, { timeout: 10_000 }).toBe(2);
  expect(portionEvents()[0]?.event_id).not.toBe(portionEvents()[1]?.event_id);
  await expect.poll(() => captures.length).toBe(2);
  expect(captures[1]?.event_id).toBe(portionEvents()[1]?.event_id);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to menu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Analytics preferences' })).toHaveCount(0);
  expect(portionEvents()).toHaveLength(2);
  expect(captures).toHaveLength(2);

  const privacyPage = await context.newPage();
  const blockedRequests: string[] = [];
  privacyPage.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === 'https://us.i.posthog.com' ||
      url.href === 'https://api.example.test/observations'
    ) {
      blockedRequests.push(url.origin);
    }
  });
  await privacyPage.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
  });
  await privacyPage.clock.install();
  await privacyPage.goto(`${dinerOrigin}/diner/portion-qa`);
  await privacyPage.locator('.pp-card__open').first().click();
  await privacyPage.getByRole('button', { name: 'View Portion', exact: true }).click();
  await expect(privacyPage.locator('.pp-detail')).toHaveAttribute('data-portion-state', 'ready');
  await privacyPage.clock.fastForward(10_000);
  await expect(privacyPage.locator('#consent')).toHaveCount(0);
  expect(blockedRequests).toEqual([]);
});

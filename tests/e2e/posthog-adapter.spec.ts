import { gunzipSync } from 'node:zlib';
import { expect, type Page, type Request, test } from '@playwright/test';

// The P0 PostHog adapter with the real pinned SDK in Chromium. The diner dev server imports it
// through the package entry point, as the diner dispatch will. Every PostHog request is
// intercepted; nothing reaches PostHog.
const diner = 'http://127.0.0.1:5173';
const eventId = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const dishViewed = {
  dish_id: eventId(400),
  dish_revision_id: eventId(401),
  exposure_id: eventId(402),
  surface: 'menu_list',
  position: 1,
  exposure_basis: 'viewport_50pct_1s',
};

function body(request: Request): Record<string, unknown> {
  const raw = request.postDataBuffer() ?? Buffer.alloc(0);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString() : raw.toString();
  return JSON.parse(text) as Record<string, unknown>;
}

async function storage(page: Page) {
  return page.evaluate(() => ({
    local: Object.keys(localStorage).sort(),
    session: Object.keys(sessionStorage).sort(),
    cookie: document.cookie,
  }));
}

async function open(page: Page, status: (n: number) => number) {
  const requests: Request[] = [];
  // Test only: the SDK's bot filter drops every event under browser automation (webdriver flag and
  // the HeadlessChrome brand). Production config keeps the filter on.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  await page.clock.install();
  await page.route('https://us.i.posthog.com/**', (route) => {
    requests.push(route.request());
    return route.fulfill({ status: status(requests.length), body: '{}' });
  });
  await page.goto(diner);
  const before = await storage(page);
  await page.addScriptTag({
    type: 'module',
    content: `
      import { createPostHogAdapter } from '/@id/@peekaplate/analytics/posthog';
      window.__posthog = createPostHogAdapter(
        {
          MODE: 'staging',
          VITE_POSTHOG_ENABLED: 'true',
          VITE_POSTHOG_ENVIRONMENT: 'staging',
          VITE_POSTHOG_HOST: 'https://us.i.posthog.com',
          VITE_POSTHOG_KEY: 'phc_browser_test_fixture',
          VITE_POSTHOG_ALLOWED_ORIGIN: location.origin,
        },
        { origin: location.origin, privacySignal: () => false, isLive: () => true },
      );`,
  });
  await page.waitForFunction(() => '__posthog' in window);
  return { requests, before };
}

const call = (page: Page, script: string) =>
  page.evaluate(`(() => { const a = window.__posthog; ${script} })()`);

test('a retry the SDK scheduled is never sent after withdrawal', async ({ page }) => {
  const { requests } = await open(page, (n) => (n === 1 ? 500 : 200));
  await call(
    page,
    `a.setConsent(true); a.capturePostHog('menu_viewed', { entry_source: 'qr' }, { eventId: '${eventId(1)}' });`,
  );
  await expect.poll(() => requests.length).toBe(1);
  await call(page, 'a.setConsent(false);');
  await page.clock.runFor(30 * 60 * 1000);
  expect(requests).toHaveLength(1);
});

test('control: without withdrawal the SDK does retry, so the check above can fail', async ({
  page,
}) => {
  const { requests } = await open(page, (n) => (n === 1 ? 500 : 200));
  await call(
    page,
    `a.setConsent(true); a.capturePostHog('menu_viewed', { entry_source: 'qr' }, { eventId: '${eventId(1)}' });`,
  );
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.runFor(30 * 60 * 1000);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.url()).toContain('retry_count=1');
});

test('opt-in, capture and withdrawal leave browser storage untouched; the event surface is kept', async ({
  page,
}) => {
  const { requests, before } = await open(page, () => 200);
  await call(
    page,
    `a.setConsent(true); a.capturePostHog('dish_viewed', ${JSON.stringify(dishViewed)}, { eventId: '${eventId(2)}' });`,
  );
  await expect.poll(() => requests.length).toBe(1);
  expect(await storage(page)).toEqual(before);

  const sent = body(requests[0] as Request) as { batch: { uuid: string; properties: object }[] };
  const [event] = sent.batch;
  expect(event?.uuid).toBe(eventId(2));
  expect(event?.properties).toMatchObject({ ...dishViewed, event_id: eventId(2) });
  expect(Object.keys(event?.properties ?? {}).filter((k) => k.startsWith('$'))).not.toContain(
    '$current_url',
  );

  await call(page, 'a.setConsent(false);');
  await call(
    page,
    `a.setConsent(true); a.capturePostHog('menu_viewed', { entry_source: 'qr' }, { eventId: '${eventId(3)}' });`,
  );
  await expect.poll(() => requests.length).toBe(2);
  expect(await storage(page)).toEqual(before);
});

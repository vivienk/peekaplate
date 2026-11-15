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
    // With the CORS header a 200 is a real success for the SDK, not a network failure it retries.
    return route.fulfill({
      status: status(requests.length),
      headers: { 'access-control-allow-origin': '*' },
      body: '{}',
    });
  });
  await page.goto(`${diner}/?scenario=empty`);
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

test('the actual diner banner dispatches one live event to the real SDK and canonical sender', async ({
  page,
}) => {
  const { requests } = await open(page, () => 200);
  await page.evaluate(async () => {
    const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
    // The real screen subscribes before the app connects its PostHog adapter.
    tracking.onTrackingAllowedChange((allowed) => {
      if (allowed)
        tracking.track('menu_viewed', {
          publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
          entry_source: 'qr',
        });
    });
    tracking.connectPostHogFromEnv({
      MODE: 'staging',
      VITE_POSTHOG_ENABLED: 'true',
      VITE_POSTHOG_ENVIRONMENT: 'staging',
      VITE_POSTHOG_HOST: 'https://us.i.posthog.com',
      VITE_POSTHOG_KEY: 'phc_browser_test_fixture',
      VITE_POSTHOG_ALLOWED_ORIGIN: location.origin,
    });
    const canonical: { event_id: string; session_id: string; producer_id: string }[] = [];
    Object.assign(window, { reviewCanonical: canonical });
    tracking.enableLiveTracking(
      async (batch: { event_id: string; session_id: string; producer_id: string }[]) => {
        canonical.push(...batch);
        return batch.map((event) => event.event_id);
      },
    );
  });
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Allow optional analytics', exact: true }).click();
  const emit = () =>
    page.evaluate(async () => {
      const { track } = await import(/* @vite-ignore */ '/src/tracking/index.ts');
      track('menu_viewed', {
        publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
        entry_source: 'qr',
      });
    });
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.runFor(5000);
  const canonical = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            reviewCanonical: { event_id: string; session_id: string; producer_id: string }[];
          }
        ).reviewCanonical,
    );
  await expect.poll(async () => (await canonical()).length).toBe(1);
  const observation = (await canonical())[0]!;
  const sent = body(requests[0]!) as {
    batch: { uuid: string; event: string; properties: object }[];
  };
  expect(sent.batch[0]).toMatchObject({
    uuid: observation.event_id,
    event: 'menu_viewed',
    properties: { event_id: observation.event_id, entry_source: 'qr' },
  });
  expect(JSON.stringify(sent)).not.toContain(observation.session_id);
  expect(JSON.stringify(sent)).not.toContain(observation.producer_id);
  await page.getByRole('button', { name: 'Turn off optional analytics' }).click();
  await emit();
  await page.clock.runFor(5000);
  expect(requests).toHaveLength(1);
  expect(await canonical()).toHaveLength(1);
});

test('a retry the SDK scheduled is never sent after withdrawal', async ({ page }) => {
  const { requests } = await open(page, (n) => (n === 1 ? 500 : 200));
  await call(
    page,
    `a.setConsent(true); a.capturePostHog('menu_viewed', { entry_source: 'qr' }, { eventId: '${eventId(1)}' });`,
  );
  await expect.poll(() => requests.length).toBe(1);
  await call(page, 'a.setConsent(false);');
  // Same 5-second steps as the control, so a retry would really reach the network.
  for (let step = 0; step < 360; step++) {
    await page.clock.runFor(5_000);
    await page.waitForTimeout(10);
  }
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
  // Small steps: one 30-minute jump would also fire the SDK's 60 s request timeout and abort the
  // retry in flight before it reaches the network.
  for (let step = 0; step < 360 && requests.length < 2; step++) {
    await page.clock.runFor(5_000);
    await page.waitForTimeout(10);
  }
  expect(requests).toHaveLength(2);
  expect(requests[1]?.url()).toContain('retry_count=1');
});

test('no request starts after a withdrawal made in the same turn as a capture', async ({
  page,
}) => {
  // Records, in page order, each PostHog request the SDK starts and the moment of withdrawal.
  await page.addInitScript(() => {
    const log: string[] = [];
    const send = window.fetch.bind(window);
    Object.assign(window, { __log: log });
    window.fetch = (input, init) => {
      if (String(input instanceof Request ? input.url : input).includes('i.posthog.com'))
        log.push('request');
      return send(input, init);
    };
  });
  const { requests } = await open(page, () => 200);
  await call(
    page,
    `a.setConsent(true); a.capturePostHog('menu_viewed', { entry_source: 'qr' }, { eventId: '${eventId(1)}' });`,
  );
  await expect.poll(() => requests.length).toBe(1);
  await call(
    page,
    `a.capturePostHog('menu_viewed', { entry_source: 'qr' }, { eventId: '${eventId(2)}' }); a.setConsent(false); window.__log.push('withdrawn');`,
  );
  await page.clock.runFor(60 * 1000);
  await page.waitForTimeout(500);
  const log = (await page.evaluate('window.__log')) as string[];
  expect(log.slice(log.indexOf('withdrawn') + 1)).toEqual([]);
  expect(log.filter((entry) => entry === 'request').length).toBe(requests.length);
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

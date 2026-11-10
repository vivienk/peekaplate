import { expect, type Page, test } from '@playwright/test';

// Real Chromium requests with synthetic receipts; this is not hosted ingestion acceptance.
const DINER = 'http://127.0.0.1:5173/';
const PUBLICATION = 'a5000000-0000-4000-8000-000000000001';
const ENDPOINT = `${DINER}__review_observations`;

async function start(page: Page, mode: 'live' | 'fixture' | 'denied' = 'live') {
  await page.goto(DINER);
  await page.evaluate(
    async ({ publication, endpoint, mode }) => {
      const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
      const { createLiveDeliver } = await import(/* @vite-ignore */ '/src/tracking/delivery.ts');
      const captures: unknown[] = [];
      const token = {
        value: 'synthetic-review-token',
        expiresAt: Date.now() + 60_000,
        publicationRevisionId: publication,
      };
      tracking.connectPostHog({
        capturePostHog: (...args: unknown[]) => captures.push(args),
        setConsent: () => {},
      });
      if (mode !== 'fixture')
        tracking.enableLiveTracking(
          createLiveDeliver({
            endpoint,
            fetch: window.fetch.bind(window),
            now: () => Date.now(),
            token: () => token,
          }),
        );
      tracking.setTrackingAllowed(mode !== 'denied');
      Object.assign(window, {
        reviewTracking: tracking,
        reviewCaptures: captures,
        reviewToken: token,
      });
    },
    { publication: PUBLICATION, endpoint: ENDPOINT, mode },
  );
}

async function track(page: Page, count = 1) {
  await page.evaluate(
    ({ publication, count }) => {
      const tracking = (
        window as unknown as { reviewTracking: { track(name: string, payload: unknown): void } }
      ).reviewTracking;
      for (let n = 0; n < count; n++)
        tracking.track('menu_viewed', {
          publication_revision_id: publication,
          entry_source: 'qr',
        });
    },
    { publication: PUBLICATION, count },
  );
}

const hide = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
const stored = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('peekaplate-tracking', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('outbox');
        open.onsuccess = () => {
          const db = open.result;
          const read = db.transaction('outbox').objectStore('outbox').get('events');
          read.onsuccess = () => {
            resolve(read.result?.length ?? 0);
            db.close();
          };
          read.onerror = () => {
            resolve(-1);
            db.close();
          };
        };
      }),
  );

test('mixed receipts retry the same event without repeating the PostHog dispatch', async ({
  page,
}) => {
  const bodies: { events: { event_id: string }[] }[] = [];
  await page.route(ENDPOINT, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer synthetic-review-token');
    const body = route.request().postDataJSON();
    expect(JSON.stringify(body)).not.toContain('synthetic-review-token');
    bodies.push(body);
    await route.fulfill({
      json: {
        contract: 'observation-receipt.v1',
        request_id: crypto.randomUUID(),
        receipts: body.events.map((event: { event_id: string }, index: number) => ({
          event_id: event.event_id,
          status: bodies.length === 1 && index === 1 ? 'retry' : 'accepted',
          reason_code: null,
          retryable: bodies.length === 1 && index === 1,
        })),
      },
    });
  });
  await start(page);
  await track(page, 2);
  await expect.poll(() => stored(page)).toBe(2);
  await hide(page);
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]?.events).toEqual([bodies[0]?.events[1]]);
  await expect.poll(() => stored(page)).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { reviewCaptures: unknown[] }).reviewCaptures.length,
    ),
  ).toBe(2);
});

for (const mode of ['fixture', 'denied'] as const) {
  test(`${mode} mode sends no observation request`, async ({ page }) => {
    let requests = 0;
    await page.route(ENDPOINT, async (route) => {
      requests++;
      await route.abort();
    });
    await start(page, mode);
    await track(page);
    await hide(page);
    await page.waitForTimeout(300);
    expect(requests).toBe(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { reviewCaptures: unknown[] }).reviewCaptures.length,
      ),
    ).toBe(0);
  });
}

test('withdrawal stops child requests after a 413 and clears the durable batch', async ({
  page,
}) => {
  let requests = 0;
  await page.route(ENDPOINT, async (route) => {
    requests++;
    await page.evaluate(() =>
      (
        window as unknown as {
          reviewTracking: { setTrackingAllowed(value: boolean): void };
        }
      ).reviewTracking.setTrackingAllowed(false),
    );
    await route.fulfill({ status: 413 });
  });
  await start(page);
  await track(page, 2);
  await expect.poll(() => stored(page)).toBe(2);
  await hide(page);
  await expect.poll(() => stored(page)).toBe(0);
  expect(requests).toBe(1);
});

test('an expired token discards the batch without a request', async ({ page }) => {
  let requests = 0;
  await page.route(ENDPOINT, async (route) => {
    requests++;
    await route.abort();
  });
  await start(page);
  await track(page);
  await expect.poll(() => stored(page)).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { reviewToken: { expiresAt: number } }).reviewToken.expiresAt = 0;
  });
  await hide(page);
  await expect.poll(() => stored(page)).toBe(0);
  expect(requests).toBe(0);
});

test('a stalled browser request times out and retries the unchanged observation', async ({
  page,
}) => {
  const bodies: { events: { event_id: string }[] }[] = [];
  await page.route(ENDPOINT, async (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    if (bodies.length === 1) return;
    await route.fulfill({
      json: {
        contract: 'observation-receipt.v1',
        request_id: crypto.randomUUID(),
        receipts: body.events.map((event: { event_id: string }) => ({
          event_id: event.event_id,
          status: 'accepted',
          reason_code: null,
          retryable: false,
        })),
      },
    });
  });
  await page.clock.install();
  await start(page);
  await track(page);
  await expect.poll(() => stored(page)).toBe(1);
  await hide(page);
  await expect.poll(() => bodies.length).toBe(1);
  await page.clock.runFor(10_000);
  await expect.poll(() => stored(page)).toBe(1);
  await page.clock.runFor(2_000);
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual(bodies[0]);
  await expect.poll(() => stored(page)).toBe(0);
});

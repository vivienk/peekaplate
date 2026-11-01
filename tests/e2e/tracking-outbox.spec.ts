import { expect, type Page, test } from '@playwright/test';

// S3-TRK-01.2 in a real browser: the consent gate, fixture mode, the IndexedDB outbox and batching.
// In live mode the test passes its own sender, standing in for TRK-01.3 delivery; nothing is sent.
const DINER = 'http://127.0.0.1:5173/';
const PUBLICATION = 'a5000000-0000-4000-8000-000000000001';

// `hold`: live mode without a sender, as in TRK-01.2 before delivery exists; events stay queued.
type Options = { live?: boolean; consent?: boolean; hold?: boolean };

async function startTracking(
  page: Page,
  { live = false, consent = false, hold = false }: Options = {},
) {
  await page.evaluate(
    async ({ live, consent, hold }) => {
      const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
      const delivered: unknown[][] = [];
      if (live && hold) tracking.enableLiveTracking();
      else if (live) {
        tracking.enableLiveTracking(async (batch: { event_id: string }[]) => {
          delivered.push(batch);
          return batch.map((event) => event.event_id);
        });
      }
      tracking.setTrackingAllowed(consent);
      Object.assign(window, { tracking, delivered });
    },
    { live, consent, hold },
  );
}

const trackMenuViewed = (page: Page, count = 1) =>
  page.evaluate(
    ({ count, publication }) => {
      const { tracking } = window as unknown as {
        tracking: { track(name: string, payload: Record<string, unknown>): void };
      };
      for (let n = 0; n < count; n++) {
        tracking.track('menu_viewed', { publication_revision_id: publication, entry_source: 'qr' });
      }
    },
    { count, publication: PUBLICATION },
  );

// What the durable outbox holds right now, read straight from IndexedDB.
const storedEvents = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('peekaplate-tracking', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('outbox');
        open.onsuccess = () => {
          const get = open.result.transaction('outbox').objectStore('outbox').get('events');
          get.onsuccess = () => resolve(Array.isArray(get.result) ? get.result.length : 0);
          get.onerror = () => resolve(-1);
        };
      }),
  );

const delivered = (page: Page) =>
  page.evaluate(() => (window as unknown as { delivered: unknown[][] }).delivered.flat().length);

const hidePage = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

test('live mode with the consent gate off (the default) queues and sends nothing', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true });
  await trackMenuViewed(page, 3);
  await hidePage(page);
  await page.waitForTimeout(300);
  expect(await storedEvents(page)).toBe(0);
  expect(await delivered(page)).toBe(0);
});

test('switching the gate on starts queuing, and a reload keeps a pending event', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true, hold: true });
  await trackMenuViewed(page, 2);
  await expect.poll(() => storedEvents(page)).toBe(2);
  await page.reload();
  expect(await storedEvents(page)).toBe(2);
});

test('offline keeps events; reconnecting releases them to the sender', async ({ page }) => {
  await page.goto(DINER);
  // Load the tracking code first; going offline earlier would block fetching it.
  await startTracking(page, { live: true, consent: true });
  await page.context().setOffline(true);
  await trackMenuViewed(page, 3);
  await expect.poll(() => storedEvents(page)).toBe(3);
  await hidePage(page);
  await page.waitForTimeout(300);
  expect(await delivered(page)).toBe(0);
  await page.context().setOffline(false);
  await expect.poll(() => delivered(page)).toBe(3);
  await expect.poll(() => storedEvents(page)).toBe(0);
});

test('hiding the page flushes the current batch', async ({ page }) => {
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true });
  await trackMenuViewed(page, 4);
  await expect.poll(() => storedEvents(page)).toBe(4);
  await hidePage(page);
  await expect.poll(() => delivered(page)).toBe(4);
});

test('a full outbox drops the oldest events with a developer warning, and the page keeps working', async ({
  page,
}) => {
  await page.goto(DINER);
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  // Load the tracking code first; going offline earlier would block fetching it.
  await startTracking(page, { live: true, consent: true });
  await page.context().setOffline(true);
  await trackMenuViewed(page, 505);
  await expect.poll(() => storedEvents(page)).toBe(500);
  expect(warnings.filter((text) => text.includes('outbox full'))).toHaveLength(5);
  await expect(page.locator('body')).toBeVisible();
});

test('fixture mode logs test events and batches to the console and makes no tracking request', async ({
  page,
}) => {
  await page.goto(DINER);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const logs: string[] = [];
  page.on('console', (message) => logs.push(message.text()));
  await startTracking(page);
  await trackMenuViewed(page, 2);
  // Fixture events never reach the durable outbox, even before a batch is flushed.
  await page.waitForTimeout(300);
  expect(await storedEvents(page)).toBe(0);
  await hidePage(page);
  await expect.poll(() => logs.filter((text) => text.includes('test batch')).length).toBe(1);
  expect(logs.filter((text) => text.includes('test event (fixture mode, not sent)'))).toHaveLength(
    2,
  );
  expect(requests.filter((url) => !url.startsWith(DINER))).toEqual([]);
  expect(requests.filter((url) => /observations|posthog/i.test(url))).toEqual([]);
  expect(await storedEvents(page)).toBe(0);
});

test('with storage blocked, other events still queue in memory under the normal rules', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined });
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
  });
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true });
  await trackMenuViewed(page, 2);
  await hidePage(page);
  await expect.poll(() => delivered(page)).toBe(2);
});

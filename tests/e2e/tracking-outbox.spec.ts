import { expect, type Page, test } from '@playwright/test';

// S3-TRK-01.2 in a real browser: the consent gate, fixture mode, the IndexedDB outbox and batching.
// In live mode the test passes its own sender, standing in for TRK-01.3 delivery; nothing is sent.
const DINER = 'http://127.0.0.1:5173/';
const PUBLICATION = 'a5000000-0000-4000-8000-000000000001';

test('the existing consent control gates both destinations even without PostHog configuration', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true });
  await page.evaluate(() => {
    const holder = window as unknown as {
      tracking: { connectPostHog(sink: unknown): void };
      reviewCaptures: unknown[];
    };
    holder.reviewCaptures = [];
    holder.tracking.connectPostHog({
      capturePostHog: (...args: unknown[]) => holder.reviewCaptures.push(args),
      setConsent: () => {},
    });
  });
  await trackMenuViewed(page);
  await hidePage(page);
  expect(await delivered(page)).toBe(0);
  await page.getByRole('button', { name: 'Allow optional analytics', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Turn off optional analytics' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await trackMenuViewed(page);
  await expect.poll(() => storedEvents(page)).toBe(1);
  await hidePage(page);
  await expect.poll(() => delivered(page)).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { reviewCaptures: unknown[] }).reviewCaptures.length,
    ),
  ).toBe(1);
  await page.getByRole('button', { name: 'Turn off optional analytics' }).click();
  await trackMenuViewed(page);
  await hidePage(page);
  await expect.poll(() => storedEvents(page)).toBe(0);
  expect(await delivered(page)).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { reviewCaptures: unknown[] }).reviewCaptures.length,
    ),
  ).toBe(1);
});

test('the consent control stays off when a browser privacy signal blocks the shared gate', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true });
  await page.evaluate(() =>
    (
      window as unknown as { tracking: { setPrivacySignal(signal: () => boolean): void } }
    ).tracking.setPrivacySignal(() => true),
  );
  const button = page.getByRole('button', { name: 'Allow optional analytics', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await trackMenuViewed(page);
  await hidePage(page);
  expect(await delivered(page)).toBe(0);
  await expect.poll(() => storedEvents(page)).toBe(0);
});

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

test('25 queued events go as one full batch straight away, without hiding the page or waiting for the timer', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true });
  await trackMenuViewed(page, 24);
  await expect.poll(() => storedEvents(page)).toBe(24);
  expect(await delivered(page)).toBe(0);
  const started = Date.now();
  await trackMenuViewed(page, 1);
  await expect.poll(() => delivered(page), { timeout: 2_000 }).toBe(25);
  // Well inside the 5-second timer, so the full-batch trigger sent it.
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('pauseDeliveryUntil holds every flush until the pause ends, then sends once by itself', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true });
  await trackMenuViewed(page, 1);
  await expect.poll(() => storedEvents(page)).toBe(1);
  await page.evaluate(() => {
    const { tracking } = window as unknown as {
      tracking: { pauseDeliveryUntil(timestampMs: number): void };
    };
    tracking.pauseDeliveryUntil(Date.now() + 2_000);
  });
  // A hidden page and a full batch would both normally send straight away.
  await trackMenuViewed(page, 24);
  await hidePage(page);
  await page.waitForTimeout(1_000);
  expect(await delivered(page)).toBe(0);
  await expect.poll(() => delivered(page), { timeout: 4_000 }).toBe(25);
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

// Shared dispatch (Sai with Vivien, 3 Nov): one consent gate with the browser privacy signals for
// both destinations; a stand-in PostHog sink records what the adapter would receive.
const connectFakePostHog = (page: Page) =>
  page.evaluate(() => {
    const { tracking } = window as unknown as {
      tracking: {
        connectPostHog(sink: {
          capturePostHog(type: string, payload: unknown, ids: { eventId: string }): void;
          setConsent(allowed: boolean): void;
        }): () => void;
      };
    };
    const captured: string[] = [];
    const consent: boolean[] = [];
    tracking.connectPostHog({
      capturePostHog: (type, _payload, ids) => captured.push(`${type}:${ids.eventId}`),
      setConsent: (allowed) => consent.push(allowed),
    });
    Object.assign(window, { postHog: { captured, consent } });
  });

const postHogInfo = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { postHog: { captured: string[]; consent: boolean[] } }).postHog,
  );

test('with Global Privacy Control on, consent given still stores and sends nothing', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
  });
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true });
  await connectFakePostHog(page);
  await trackMenuViewed(page, 3);
  await hidePage(page);
  await page.waitForTimeout(300);
  expect(await storedEvents(page)).toBe(0);
  expect(await delivered(page)).toBe(0);
  const posthog = await postHogInfo(page);
  expect(posthog.captured).toEqual([]);
  expect(posthog.consent).toEqual([false]);
});

test('withdrawing consent empties the stored outbox and stops both destinations', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true, hold: true });
  await connectFakePostHog(page);
  await trackMenuViewed(page, 2);
  await expect.poll(() => storedEvents(page)).toBe(2);
  await page.evaluate(() =>
    (
      window as unknown as { tracking: { setTrackingAllowed(v: boolean): void } }
    ).tracking.setTrackingAllowed(false),
  );
  await expect.poll(() => storedEvents(page)).toBe(0);
  await trackMenuViewed(page, 1);
  await page.waitForTimeout(300);
  expect(await storedEvents(page)).toBe(0);
  const posthog = await postHogInfo(page);
  expect(posthog.captured).toHaveLength(2);
  expect(posthog.consent.at(-1)).toBe(false);
});

test('each live event reaches PostHog once with the canonical event_id; fixture mode sends none', async ({
  page,
}) => {
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true });
  await connectFakePostHog(page);
  await trackMenuViewed(page, 3);
  // Hide only once every event is stored, so the hide flush sends them all.
  await expect.poll(() => storedEvents(page)).toBe(3);
  await hidePage(page);
  await expect.poll(() => delivered(page)).toBe(3);
  const canonicalIds = await page.evaluate(() =>
    (window as unknown as { delivered: { event_id: string }[][] }).delivered
      .flat()
      .map((event) => event.event_id),
  );
  const posthog = await postHogInfo(page);
  expect(posthog.captured).toEqual(canonicalIds.map((id) => `menu_viewed:${id}`));

  // A fresh page in fixture mode: nothing reaches PostHog.
  await page.reload();
  await startTracking(page);
  await connectFakePostHog(page);
  await trackMenuViewed(page, 2);
  await hidePage(page);
  await page.waitForTimeout(300);
  expect((await postHogInfo(page)).captured).toEqual([]);
});

// Fixtures README (observation.v2): browser delivery tests owned by TRK-01. Save and Unsave report
// success only for committed writes, so a failed Save storage write must never reach delivery.
// Save's hearts are wired to the real track(); only localStorage (Save's store) is blocked, so the
// IndexedDB outbox still works.
async function saveAndUnsaveThroughTracking(page: Page, blockSaveStorage: boolean) {
  await page.goto(DINER);
  await startTracking(page, { live: true, consent: true });
  await page.evaluate(async (blockSaveStorage) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createSaveState } = await load('/src/save/save-state.ts');
    const { mountSaveHeart } = await load('/src/save/mount.ts');
    const fixtures = await load('/src/menu/fixtures.ts');
    const { toMenu } = await load('/src/menu/adapter.ts');
    const menu = toMenu(
      fixtures.edgeCaseBundle,
      'fixture',
      fixtures.FIXTURE_PUBLICATION_REVISION_ID,
    ).menu;
    const dish = menu.categories
      .flatMap((c: { dishes: { dishId: string }[] }) => c.dishes)
      .find((d: { dishId: string }) => d.dishId === fixtures.DISH.avocadoToast);
    if (blockSaveStorage) {
      Storage.prototype.setItem = () => {
        throw new DOMException('blocked', 'SecurityError');
      };
    }
    const saveState = createSaveState({ venueId: menu.venueId });
    saveState.reconcile(menu);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Save Avocado Toast';
    document.body.append(button);
    const { tracking } = window as unknown as {
      tracking: { track(name: string, payload: Record<string, unknown>): void };
    };
    mountSaveHeart(button, {
      saveState,
      menu,
      dish,
      surface: 'menu_card',
      send: (name: string, payload: Record<string, unknown>) => tracking.track(name, payload),
    });
    button.click();
    button.click();
  }, blockSaveStorage);
  // A control event, so the test knows delivery ran.
  await trackMenuViewed(page);
  await hidePage(page);
  await expect.poll(() => delivered(page)).toBeGreaterThan(0);
  return page.evaluate(() =>
    (window as unknown as { delivered: { type: string }[][] }).delivered
      .flat()
      .map((event) => event.type),
  );
}

test('committed Save and Unsave reach delivery once each', async ({ page }) => {
  expect(await saveAndUnsaveThroughTracking(page, false)).toEqual([
    'dish_saved',
    'dish_unsaved',
    'menu_viewed',
  ]);
});

test('when Save storage fails, no Save or Unsave success event reaches delivery', async ({
  page,
}) => {
  expect(await saveAndUnsaveThroughTracking(page, true)).toEqual(['menu_viewed']);
});

// A failed send keeps the event, and its retry, even after a reload, carries the identical
// envelope: same event_id, session_id, producer_id, local_sequence, timestamps and payload.
test('a retried event keeps its identity, even across a reload', async ({ page }) => {
  await page.goto(DINER);
  await page.evaluate(async () => {
    const tracking = await import(/* @vite-ignore */ '/src/tracking/index.ts');
    tracking.enableLiveTracking(async (batch: unknown[]) => {
      sessionStorage.setItem('attempted', JSON.stringify(batch));
      throw new Error('503');
    });
    tracking.setTrackingAllowed(true);
    Object.assign(window, { tracking });
  });
  await trackMenuViewed(page);
  await expect.poll(() => storedEvents(page)).toBe(1);
  await hidePage(page);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('attempted'))).not.toBeNull();
  expect(await storedEvents(page)).toBe(1);

  await page.reload();
  await startTracking(page, { live: true, consent: true });
  await hidePage(page);
  await expect.poll(() => delivered(page)).toBe(1);
  const [attempted, retried] = await page.evaluate(() => [
    JSON.parse(sessionStorage.getItem('attempted') ?? '[]'),
    (window as unknown as { delivered: unknown[][] }).delivered.flat(),
  ]);
  expect(attempted).toHaveLength(1);
  expect(retried).toEqual(attempted);
});

import { expect, type Page, test } from '@playwright/test';

// S3-DIN-01 triggers in a real page: dish_viewed exposure rules, and the dish detail activity
// clock driven by window scroll. Events are read from the dev-mode [track] console log, so no
// network or live tracking is involved. Evidence is fixture only.
const ORIGIN = 'http://127.0.0.1:5173/';
const IDLE_PAUSE_MS = 30_000;

type Tracked = { type: string; payload: Record<string, unknown> };
type Globals = { __tracked: Tracked[]; __scrollListeners: Set<unknown> };

// Must run before page.goto. Records every [track] envelope and every window scroll listener
// that is currently attached.
async function recordPage(page: Page) {
  await page.addInitScript(() => {
    const g = window as unknown as Globals;
    g.__tracked = [];
    g.__scrollListeners = new Set();
    for (const level of ['log', 'info', 'debug'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('[track]')) {
          const envelope = args.find((arg) => typeof arg === 'object' && arg !== null);
          if (envelope) g.__tracked.push(JSON.parse(JSON.stringify(envelope)));
        }
        original(...args);
      };
    }
    const add = window.addEventListener.bind(window) as (...a: unknown[]) => void;
    const remove = window.removeEventListener.bind(window) as (...a: unknown[]) => void;
    window.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
      if (type === 'scroll') g.__scrollListeners.add(listener);
      add(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
      if (type === 'scroll') g.__scrollListeners.delete(listener);
      remove(type, listener, options);
    }) as typeof window.removeEventListener;
  });
}

const tracked = (page: Page, type: string) =>
  page.evaluate(
    (type) => (window as unknown as Globals).__tracked.filter((e) => e.type === type),
    type,
  );

const activeMs = async (page: Page) =>
  (await tracked(page, 'dish_activity_checkpoint')).map((e) => e.payload.active_ms as number);

const scrollListeners = (page: Page) =>
  page.evaluate(() => (window as unknown as Globals).__scrollListeners.size);

async function openMenu(page: Page, scenario: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ORIGIN}?scenario=${scenario}`);
  await expect(page.locator('.pp-category:not([hidden]) .pp-card').first()).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('dish_viewed exposure', () => {
  test('fires once per visible dish, never twice for the same dish, and does not repeat', async ({
    page,
  }) => {
    await recordPage(page);
    await openMenu(page, 'demo');
    await expect.poll(async () => (await tracked(page, 'dish_viewed')).length).toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    const first = await tracked(page, 'dish_viewed');
    const ids = first.map((e) => e.payload.dish_id);
    // Every event names its dish, and the hidden per-category copies add no second event.
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    await page.waitForTimeout(3000);
    expect((await tracked(page, 'dish_viewed')).length).toBe(first.length);
  });

  test('fires nothing while the tab is hidden', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    });
    await recordPage(page);
    await openMenu(page, 'demo');
    await page.waitForTimeout(2500);
    expect(await tracked(page, 'dish_viewed')).toEqual([]);
  });

  test('fires nothing for an incomplete dish', async ({ page }) => {
    await recordPage(page);
    await openMenu(page, 'edge-cases');
    await expect.poll(async () => (await tracked(page, 'dish_viewed')).length).toBeGreaterThan(0);
    await page.waitForTimeout(2000);

    const incompleteId = await page.evaluate(async () => {
      const fixtures = await import(/* @vite-ignore */ '/src/menu/fixtures.ts');
      return fixtures.DISH.incomplete as string;
    });
    const events = await tracked(page, 'dish_viewed');
    expect(events.some((e) => JSON.stringify(e.payload).includes(incompleteId))).toBe(false);
  });
});

test.describe('dish detail activity clock', () => {
  // The fake clock is paused, so time moves only through runFor. Window scroll is simulated with a
  // scroll event because the short detail page may not be scrollable at 390x844.
  async function openDetail(page: Page) {
    await page.clock.install({ time: new Date('2026-11-04T10:00:00Z') });
    await recordPage(page);
    await openMenu(page, 'demo');
    await page.clock.pauseAt(new Date('2026-11-04T10:05:00Z'));
    await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
    await expect(page.locator('.pp-detail')).toBeVisible({ timeout: 10_000 });
  }

  const scroll = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('scroll')));

  test('window scroll keeps the clock active past 30 s, then idle pauses it', async ({ page }) => {
    await openDetail(page);
    for (let i = 0; i < 4; i++) {
      await scroll(page);
      await page.clock.runFor(10_000);
    }
    // Scrolling every 10 s for 40 s: without scroll input the clock would have stopped at 30 s.
    expect(Math.max(...(await activeMs(page)))).toBeGreaterThan(IDLE_PAUSE_MS);

    // The last input was at 30 s, so the clock stops 30 s later, at 60 s, and stays there.
    await page.clock.runFor(120_000);
    const paused = await activeMs(page);
    expect(Math.max(...paused)).toBeGreaterThan(40_000);
    expect(Math.max(...paused)).toBeLessThanOrEqual(2 * IDLE_PAUSE_MS);
    await page.clock.runFor(60_000);
    expect((await activeMs(page)).length).toBe(paused.length);
  });

  test('leaving the detail sends one final checkpoint, removes the scroll listener, and goes quiet', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date('2026-11-04T10:00:00Z') });
    await recordPage(page);
    await openMenu(page, 'demo');
    await page.clock.pauseAt(new Date('2026-11-04T10:05:00Z'));
    const menuListeners = await scrollListeners(page);

    await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
    await expect(page.locator('.pp-detail')).toBeVisible({ timeout: 10_000 });
    expect(await scrollListeners(page)).toBeGreaterThan(menuListeners);
    await scroll(page);
    await page.clock.runFor(7000);

    await page.locator('.pp-detail__back').click();
    await expect(page.locator('.pp-detail')).toBeHidden();
    expect(await scrollListeners(page)).toBe(menuListeners);

    const checkpoints = await tracked(page, 'dish_activity_checkpoint');
    expect(checkpoints.filter((e) => e.payload.final === true)).toHaveLength(1);

    // Scrolling the menu afterwards is not detail activity: nothing more is sent.
    await scroll(page);
    await page.clock.runFor(120_000);
    expect((await tracked(page, 'dish_activity_checkpoint')).length).toBe(checkpoints.length);
  });
});

test.describe('dish_viewed 1 s timer', () => {
  // Scrolls so that `fraction` of the card is visible at the bottom edge of the viewport.
  const showFraction = (page: Page, dishId: string, fraction: number) =>
    page.evaluate(
      ({ dishId, fraction }) => {
        const card = document.querySelector(
          `.pp-category:not([hidden]) .pp-card[data-dish-id="${dishId}"]`,
        );
        if (!card) throw new Error('card not found');
        const rect = card.getBoundingClientRect();
        const wantedTop = window.innerHeight - fraction * rect.height;
        window.scrollBy({ top: rect.top - wantedTop, behavior: 'instant' });
      },
      { dishId, fraction },
    );

  const viewsOf = async (page: Page, dishId: string) =>
    (await tracked(page, 'dish_viewed')).filter((e) => e.payload.dish_id === dishId);

  test('below 50% never counts, and leaving 50% restarts the 1 s timer', async ({ page }) => {
    await recordPage(page);
    await openMenu(page, 'layout-20');
    // A card well below the first screen, so nothing has fired for it yet.
    const dishId = await page
      .locator('.pp-category:not([hidden]) .pp-card[data-dish-id]')
      .nth(8)
      .getAttribute('data-dish-id');
    if (!dishId) throw new Error('expected a ninth card');

    // 40% visible: no event, however long it stays.
    await showFraction(page, dishId, 0.4);
    await page.waitForTimeout(1500);
    expect(await viewsOf(page, dishId)).toEqual([]);

    // 60% for 0.5 s, back to 40%, 60% for 0.5 s: 1 s in total but never continuous.
    await showFraction(page, dishId, 0.6);
    await page.waitForTimeout(500);
    await showFraction(page, dishId, 0.4);
    await page.waitForTimeout(100);
    await showFraction(page, dishId, 0.6);
    await page.waitForTimeout(500);
    expect(await viewsOf(page, dishId)).toEqual([]);

    // Staying at 60% past the full second, counted again from the second entry, fires once.
    await expect.poll(async () => (await viewsOf(page, dishId)).length).toBe(1);
    await page.waitForTimeout(1500);
    expect(await viewsOf(page, dishId)).toHaveLength(1);
  });
});

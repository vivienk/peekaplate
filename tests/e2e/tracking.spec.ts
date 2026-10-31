import { expect, type Page, test } from '@playwright/test';

// S3-TRK-01.1 per-tab identity in a real browser: real sessionStorage, reloads and a second tab.
// window.open copies sessionStorage into the new tab, the same way duplicating a tab does.
const DINER = 'http://127.0.0.1:5173/';

type Ids = { sessionId: string; producerId: string; localSequence: number };

async function nextIds(page: Page, count: number): Promise<Ids[]> {
  return page.evaluate(async (count) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createIdentity, browserSessionStore, browserLifecycle } = await load(
      '/src/tracking/identity.ts',
    );
    const holder = window as unknown as { identity?: { next(): Ids } };
    holder.identity ??= createIdentity({
      store: browserSessionStore(),
      uuid: () => crypto.randomUUID(),
      now: () => Date.now(),
      lifecycle: browserLifecycle(),
    });
    return Array.from({ length: count }, () => (holder.identity as { next(): Ids }).next());
  }, count);
}

test('a reload in the same tab keeps the IDs and continues the sequence', async ({ page }) => {
  await page.goto(DINER);
  const [first] = await nextIds(page, 2);
  await page.reload();
  const [afterReload] = await nextIds(page, 1);
  expect(afterReload).toEqual({ ...first, localSequence: 3 });
});

test('a second tab with copied sessionStorage gets its own IDs; the original keeps its own', async ({
  page,
  context,
}) => {
  await page.goto(DINER);
  const [original] = await nextIds(page, 1);
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate((url) => {
      window.open(url, '_blank');
    }, DINER),
  ]);
  await popup.waitForLoadState();
  const copied = await popup.evaluate(() =>
    window.sessionStorage.getItem('peekaplate:tracking:identity:v1'),
  );
  expect(copied).not.toBeNull();
  const [duplicate] = await nextIds(popup, 1);
  expect(duplicate?.producerId).not.toBe(original?.producerId);
  expect(duplicate?.sessionId).not.toBe(original?.sessionId);
  expect(duplicate?.localSequence).toBe(1);
  const [originalNext] = await nextIds(page, 1);
  expect(originalNext).toEqual({ ...original, localSequence: 2 });
});

test('IDs are lowercase UUIDs and nothing is kept outside the tab', async ({ page }) => {
  await page.goto(DINER);
  const [ids] = await nextIds(page, 1);
  expect(ids?.producerId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  expect(await page.evaluate(() => document.cookie)).toBe('');
});

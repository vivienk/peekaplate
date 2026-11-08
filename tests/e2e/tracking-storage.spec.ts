import { expect, type Page, test } from '@playwright/test';
import type { Envelope } from '../../frontend/diner/src/tracking/envelope';
import type { Outbox } from '../../frontend/diner/src/tracking/outbox';

const DINER = 'http://127.0.0.1:5173/';
function event(): Envelope {
  return {
    schema_version: 'observation.v2',
    event_id: crypto.randomUUID(),
    type: 'menu_viewed',
    session_id: crypto.randomUUID(),
    producer_id: crypto.randomUUID(),
    local_sequence: 1,
    occurred_at: new Date().toISOString(),
    publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
    payload: { entry_source: 'qr' },
  };
}
async function openBox(page: Page, kind: 'indexedDB' | 'localStorage') {
  await page.goto(DINER);
  await page.evaluate(async (kind) => {
    const source = await import(/* @vite-ignore */ '/src/tracking/outbox.ts');
    const store =
      kind === 'indexedDB'
        ? await source.indexedDbOutboxStore(indexedDB)
        : source.localStorageOutboxStore(localStorage);
    Object.assign(window, { reviewBox: await source.createOutbox(store, { now: Date.now }) });
  }, kind);
}
const ids = (page: Page) =>
  page.evaluate(async () =>
    (await (window as unknown as { reviewBox: Outbox }).reviewBox.pending())
      .map((item) => item.event_id)
      .sort(),
  );
const add = (page: Page, value: Envelope) =>
  page.evaluate(
    (value) => (window as unknown as { reviewBox: Outbox }).reviewBox.add(value),
    value,
  );

for (const kind of ['indexedDB', 'localStorage'] as const) {
  test(`${kind}: separate tabs preserve interleaved adds, receipts and clear`, async ({
    page,
    context,
  }) => {
    const other = await context.newPage();
    await openBox(page, kind);
    await openBox(other, kind);
    const a = event(),
      b = event(),
      c = event();
    await Promise.all([add(page, a), add(other, b)]);
    expect(await ids(page)).toEqual([a.event_id, b.event_id].sort());
    await Promise.all([
      page.evaluate(
        (id) => (window as unknown as { reviewBox: Outbox }).reviewBox.remove([id]),
        a.event_id,
      ),
      add(other, c),
    ]);
    expect(await ids(other)).toEqual([b.event_id, c.event_id].sort());
    await page.evaluate(() => (window as unknown as { reviewBox: Outbox }).reviewBox.clear());
    await other.evaluate(
      (id) => (window as unknown as { reviewBox: Outbox }).reviewBox.remove([id]),
      b.event_id,
    );
    expect(await ids(other)).toEqual([]);
    expect(await ids(page)).toEqual([]);
  });
}

test('an IndexedDB request success followed by abort is not reported as a committed update', async ({
  page,
}) => {
  await page.goto(DINER);
  const aborted = await page.evaluate(async (value) => {
    const { indexedDbOutboxStore } = await import(/* @vite-ignore */ '/src/tracking/outbox.ts');
    const store = await indexedDbOutboxStore(indexedDB);
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = original.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
    try {
      await store.update(() => [value]);
      return false;
    } catch {
      return true;
    } finally {
      IDBObjectStore.prototype.put = original;
    }
  }, event());
  expect(aborted).toBe(true);
});

test('without Web Locks the localStorage fallback stays in visit memory', async ({ page }) => {
  await page.goto(DINER);
  const state = await page.evaluate(async (value) => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const { localStorageOutboxStore, createOutbox } = await import(
      /* @vite-ignore */ '/src/tracking/outbox.ts'
    );
    const box = await createOutbox(localStorageOutboxStore(localStorage), { now: Date.now });
    await box.add(value);
    return {
      pending: (await box.pending()).length,
      stored: localStorage.getItem('peekaplate:tracking:outbox:v1'),
    };
  }, event());
  expect(state).toEqual({ pending: 1, stored: null });
});

import { expect, test } from '@playwright/test';

// Explicit synthetic harness: the production caller mounts the same controller
// only for verified published menus. No fixture automatically contacts the API.
test('an open dish gains approved artwork and loses revoked artwork without rebuilding', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:5173/?scenario=demo');
  await page.locator('.pp-card__open').first().click();
  await page.clock.install();
  let approved = false;
  let requests = 0;
  const sha = 'a'.repeat(64);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJElEQVR4nO3MMQEAAAgDoEU0ju01hIcPBCABADiarrkeAEA+LbVgAsefyYE+AAAAAElFTkSuQmCC',
    'base64',
  );
  await page.route('**/public/venues/*/ingredient-icons**', async (route) => {
    requests++;
    if (route.request().url().includes('/image?')) {
      await route.fulfill({ status: approved ? 200 : 404, contentType: 'image/png', body: png });
    } else {
      await route.fulfill({
        json: {
          schemaVersion: 1,
          icons: approved
            ? [{ label: 'avocado', version: 1, status: 'approved', sha256: sha }]
            : [],
        },
      });
    }
  });
  await page.evaluate(async () => {
    // @ts-expect-error Browser harness loads Vite source directly.
    const { mountLiveArtwork } = await import('/src/menu/liveArtwork.ts');
    const container = document.querySelector('.pp-detail')!;
    const ingredients = [...container.querySelectorAll('.pp-ingredient__name')].map(
      (node, index) => ({ ingredientId: String(index), name: node.textContent, description: null }),
    );
    (window as unknown as { stopArtwork: () => void }).stopArtwork = mountLiveArtwork(
      container,
      { ingredients },
      { apiBase: location.origin, venueId: '11111111-1111-4111-8111-111111111111' },
    );
  });
  const tile = page.locator('.pp-ingredient').filter({ hasText: 'Avocado' });
  await expect.poll(() => requests).toBeGreaterThan(0);
  const original = await tile.locator('img').getAttribute('src');
  approved = true;
  await page.clock.fastForward(30_000);
  await expect(tile.locator('img')).toHaveAttribute('src', /ingredient-icons\/image/);
  await expect
    .poll(() => tile.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(32);
  await expect(tile.locator('.pp-ingredient__name')).toHaveText('Avocado');
  approved = false;
  await page.clock.fastForward(30_000);
  await expect(tile.locator('img')).toHaveAttribute('src', original!);
  await expect(page.locator('.pp-allergy-note')).toBeVisible();
  await page.evaluate(() => (window as unknown as { stopArtwork: () => void }).stopArtwork());
  const before = requests;
  await page.clock.fastForward(60_000);
  expect(requests).toBe(before);
});

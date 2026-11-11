import { expect, type Page, test } from '@playwright/test';

// Synthetic source seam only: real rendering/refresher, no integrity or hosted-delivery claim.
async function openRefreshMenu(page: Page) {
  await page.route('**/src/menu/menuScreen.ts*', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replaceAll('import.meta.env.VITE_MENU_SOURCE', '"live"')
      .replaceAll('import.meta.env.VITE_PUBLIC_API_URL', '"http://127.0.0.1:5173"');
    await route.fulfill({ response, body });
  });
  await page.route('**/src/menu/published.ts*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `import { createFixtureMenuSource } from '/src/menu/fixtures.ts';
        export function createPublishedMenuSource(options) {
          let revision = 0;
          return { async load() {
            const result = await createFixtureMenuSource('demo').load();
            const menu = { ...result.menu, source: 'published', notice: null,
              publicationRevisionId: 'synthetic-publication-' + revision++ };
            if (window.removeDish) menu.categories = menu.categories.map(category => ({
              ...category, dishes: category.dishes.filter(dish => dish.dishId !== window.removeDish)
            }));
            options.onDelivery({ token: 'synthetic-only', expiresAt: Date.now() + 1800000,
              publicationId: menu.publicationRevisionId });
            return { status: 'ready', menu };
          }};
        }`,
    }),
  );
  await page.route('**/src/menu/refresh.ts*', async (route) => {
    if (route.request().url().includes('original')) return route.continue();
    await route.fulfill({
      contentType: 'text/javascript',
      body: `import { createMenuRefresher as create } from '/src/menu/refresh.ts?original';
        export function createMenuRefresher(options) {
          const refresher = create(options);
          window.refreshMenu = () => refresher.refresh();
          return refresher;
        }`,
    });
  });
  await page.goto(
    'http://127.0.0.1:5173/venues/00000000-0000-4000-8000-000000000001/menus/00000000-0000-4000-8000-000000000002',
  );
  await expect(page.locator('.pp-card__open').first()).toBeVisible();
}

async function refresh(page: Page) {
  await page.evaluate(() => (window as unknown as { refreshMenu(): Promise<void> }).refreshMenu());
}

test('publication refresh preserves focused Search and its query', async ({ page }) => {
  await openRefreshMenu(page);
  await page.getByRole('button', { name: 'Search menu', exact: true }).click();
  const input = page.getByRole('searchbox');
  await input.fill('avocado');
  await refresh(page);
  await expect(input).toHaveValue('avocado');
  await expect(input).toBeFocused();
});

test('return from a removed dish focuses the new menu heading', async ({ page }) => {
  await openRefreshMenu(page);
  const opener = page.locator('.pp-card__open').first();
  const dishId = await opener.getAttribute('data-open-dish-id');
  await opener.click();
  await page.evaluate((id) => {
    (window as unknown as { removeDish: string | null }).removeDish = id;
  }, dishId);
  await refresh(page);
  await expect(page.locator('.pp-detail')).toBeVisible();
  await page.locator('.pp-detail__back').click();
  await expect(page.locator('h1')).toBeFocused();
});

test('refresh retains the visible category opener rather than its hidden All copy', async ({
  page,
}) => {
  await openRefreshMenu(page);
  await page.locator('.pp-tab').nth(1).click();
  const opener = page.locator('.pp-category:not([hidden]) .pp-card__open').first();
  await opener.focus();
  await refresh(page);
  await expect(opener).toBeFocused();
});

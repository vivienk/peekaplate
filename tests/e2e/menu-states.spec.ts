import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const states = [
  'demo',
  'empty',
  'unavailable',
  'error',
  'offline',
  'edge-cases',
  'layout-20',
] as const;
function finalSelectorFor(scenario: (typeof states)[number]): string {
  return scenario === 'unavailable' || scenario === 'error' || scenario === 'offline'
    ? '.pp-menu--state'
    : '.pp-menu';
}

for (const scenario of states) {
  test(`menu state ${scenario} renders at 390px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:5173/?scenario=${scenario}`);

    await expect(page.locator(finalSelectorFor(scenario))).toBeVisible({
      timeout: 10_000,
    });

    await page.screenshot({
      path: `test-results/menu-${scenario}-fixture.png`,
      fullPage: true,
    });

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(
      violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  });
}

test('incomplete placeholder is non-interactive and accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=edge-cases');

  const placeholder = page.locator('.pp-card--placeholder').first();
  await expect(placeholder).toBeAttached({ timeout: 10_000 });
  const categoryId = await placeholder
    .locator('xpath=ancestor::div[contains(@class,"pp-category")]')
    .getAttribute('data-category-id');
  await page.locator(`.pp-tab[data-category-id="${categoryId}"]`).click();
  await expect(placeholder).toBeVisible();

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});

test('dish detail with allergen section is accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=edge-cases');

  const openButton = page.locator('.pp-card__open').first();
  await expect(openButton).toBeVisible({ timeout: 10_000 });
  await openButton.click();

  await expect(page.locator('.pp-allergen-section')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({
    path: 'test-results/dish-detail-allergen-fixture.png',
    fullPage: true,
  });

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});
test('only selected category is visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=demo');

  await expect(page.locator('.pp-menu')).toBeVisible({ timeout: 10_000 });

  const categories = page.locator('.pp-category');
  await expect(categories).toHaveCount(3);
  await expect(categories.nth(0)).toBeVisible();
  await expect(categories.nth(1)).toBeHidden();
  await expect(categories.nth(2)).toBeHidden();

  await page.getByRole('button', { name: 'Brunch Bowls' }).click();
  await expect(categories.nth(0)).toBeHidden();
  await expect(categories.nth(1)).toBeVisible();
  await expect(categories.nth(2)).toBeHidden();
});

for (const width of [320, 390]) {
  test(`dish detail has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('http://127.0.0.1:5173/?scenario=edge-cases');

    const openButton = page.locator('.pp-card__open').first();
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.click();

    await expect(page.locator('.pp-detail')).toBeVisible({ timeout: 10_000 });

    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasOverflow).toBe(false);
  });
}

test('keyboard open and back restores category and focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=demo');

  await page.getByRole('button', { name: 'Brunch Bowls' }).click();
  const opener = page.locator('.pp-category:not([hidden]) .pp-card__open').first();
  await expect(opener).toBeVisible({ timeout: 10_000 });
  const dishId = await opener.getAttribute('data-open-dish-id');
  await opener.focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('.pp-detail')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.pp-detail__title')).toBeFocused();

  await page.locator('.pp-detail__back').focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('.pp-menu')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Brunch Bowls' })).toHaveClass(/pp-tab--active/);
  await expect(page.locator(`.pp-card__open[data-open-dish-id="${dishId}"]`)).toBeFocused();
});
test('observers are disconnected across open/Back cycles', async ({ page }) => {
  await page.addInitScript(() => {
    const Real = window.IntersectionObserver;
    const live = new Set<unknown>();
    (window as unknown as { __live: Set<unknown> }).__live = live;
    window.IntersectionObserver = class extends Real {
      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        super(cb, opts);
        live.add(this);
      }
      disconnect() {
        live.delete(this);
        super.disconnect();
      }
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=demo');
  const liveCount = () =>
    page.evaluate(() => (window as unknown as { __live: Set<unknown> }).__live.size);

  for (let i = 0; i < 3; i++) {
    await expect(page.locator('.pp-menu')).toBeVisible({ timeout: 10_000 });
    expect(await liveCount()).toBe(1);
    await page.locator('.pp-category:not([hidden]) .pp-card__open').first().click();
    await expect(page.locator('.pp-detail')).toBeVisible();
    expect(await liveCount()).toBe(0);
    await page.locator('.pp-detail__back').click();
  }
});

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

for (const scenario of states) {
  test(`menu state ${scenario} renders at 390px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:5173/?scenario=${scenario}`);

    await expect(page.locator('.pp-menu, .pp-menu--state, .pp-menu--loading')).toBeVisible({
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

  await expect(page.locator('.pp-card--placeholder').first()).toBeVisible({ timeout: 10_000 });

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

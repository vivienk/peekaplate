import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const MESSAGES: Record<string, string> = {
  empty: 'No dishes are available right now.',
  unavailable: 'This menu is unavailable right now.',
  error: 'We could not load the menu. Please try again.',
  offline: 'You appear to be offline. Please check your connection.',
};

async function waitForFinalState(page: Page, scenario: string) {
  const message = MESSAGES[scenario];
  if (message) {
    await expect(page.getByText(message)).toBeVisible({ timeout: 10_000 });
  } else {
    await expect(
      page
        .locator(
          '.pp-menu:not(.pp-menu--loading):not(.pp-menu--state) .pp-category:not([hidden]) .pp-card',
        )
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  }
  await expect(page.locator('.pp-menu--loading')).toHaveCount(0);
}

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

    await waitForFinalState(page, scenario);

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

  await waitForFinalState(page, 'demo');

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
  // Check aria-pressed state right after clicking Brunch Bowls
  await expect(page.getByRole('button', { name: 'Brunch Bowls' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Breakfast' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.keyboard.press('Enter');

  await expect(page.locator('.pp-detail')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.pp-detail__title')).toBeFocused();

  await page.locator('.pp-detail__back').focus();
  await page.keyboard.press('Enter');

  // Check initial aria-pressed state
  await expect(page.getByRole('button', { name: 'Brunch Bowls' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Breakfast' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await expect(page.locator(`[data-open-dish-id="${dishId}"]`)).toBeFocused();
});

test('delayed-load regression: empty with delayMs=3000', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/?scenario=empty&delayMs=3000');

  // Loading should be visible initially
  await expect(page.locator('.pp-menu--loading')).toBeVisible({ timeout: 10_000 });

  // After delay, loading should disappear and empty state should be visible
  await waitForFinalState(page, 'empty');

  // Verify empty message is visible
  await expect(page.getByText(MESSAGES.empty)).toBeVisible({ timeout: 10_000 });

  // Verify no loading remains
  await expect(page.locator('.pp-menu--loading')).toHaveCount(0);
});

for (const scenario of ['edge-cases', 'layout-20']) {
  test(`card boundary test at 320px and 390px for ${scenario}`, async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`http://127.0.0.1:5173/?scenario=${scenario}`);

      await waitForFinalState(page, scenario);

      // Click each category tab and check card boundaries
      const tabIds = await page
        .locator('.pp-tab')
        .evaluateAll((tabs) => tabs.map((t) => (t as HTMLElement).dataset.categoryId ?? ''));

      for (const id of tabIds) {
        await page.locator(`.pp-tab[data-category-id="${id}"]`).click();

        const problems = await page.evaluate(() => {
          const out: string[] = [];
          const cards = document.querySelectorAll(
            '.pp-category:not([hidden]) .pp-card:not(.pp-card--placeholder)',
          );
          cards.forEach((card) => {
            const c = card.getBoundingClientRect();
            if (card.scrollWidth > card.clientWidth) out.push('card scrollWidth > clientWidth');
            card.querySelectorAll('*').forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.width === 0) return;
              if (r.right > c.right + 0.5 || r.left < c.left - 0.5) {
                out.push(`${el.className} outside card`);
              }
            });
          });
          return out;
        });

        expect(problems).toEqual([]);
      }
    }
  });
}
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

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const demo = 'http://127.0.0.1:5174/foundations.html';

test('input demo is labelled as synthetic and saves nothing', async ({ page }) => {
  await page.goto(demo);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Input foundation');
  await expect(page.getByText('Synthetic demo', { exact: false })).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
});

test('inputs expose their label, hint and error to assistive technology', async ({ page }) => {
  await page.goto(demo);

  const name = page.getByLabel('Dish name');
  await expect(name).toHaveAccessibleDescription('Shown to diners on the menu.');
  await expect(name).not.toHaveAttribute('aria-invalid');
  await expect(name).toHaveAttribute('required', '');

  const price = page.getByLabel('Price');
  await expect(price).toHaveAttribute('aria-invalid', 'true');
  await expect(price).toHaveAccessibleDescription(
    'Numbers only, for example 12.50. Error: Enter a price',
  );

  // The demo passes whitespace-only hint and error text here; it must be ignored.
  const note = page.getByLabel('Internal note');
  await expect(note).not.toHaveAttribute('aria-describedby');
  await expect(note).not.toHaveAttribute('aria-invalid');
  await expect(page.locator('.pp-input__hint, .pp-input__error')).toHaveCount(3);

  const filled = page.getByLabel('Short name');
  await expect(filled).toHaveValue('Berry pancakes');
  await expect(filled).toBeEditable();
  await expect(filled).not.toHaveAttribute('aria-invalid');

  await expect(page.getByLabel('Category')).toBeDisabled();

  await name.fill('Synthetic pancakes');
  await expect(name).toHaveValue('Synthetic pancakes');
});

test('the error border does not move the input text', async ({ page }) => {
  await page.goto(demo);
  const textStart = (label: string) =>
    page.getByLabel(label).evaluate((element) => {
      const style = getComputedStyle(element);
      return Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    });
  expect(await textStart('Price')).toBe(await textStart('Dish name'));
});

test('keyboard focus skips disabled inputs and stays visible', async ({ page }) => {
  await page.goto(demo);
  const order = ['Dish name', 'Price', 'Short name', 'Internal note'];
  await page.getByLabel(order[0] ?? '').focus();
  for (const [index, label] of order.entries()) {
    if (index > 0) await page.keyboard.press('Tab');
    const field = page.getByLabel(label);
    await expect(field).toBeFocused();
    const outline = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThan(0);
  }
});

test('input demo fits a narrow viewport with usable touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(demo);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const fields = await page.getByRole('textbox').all();
  expect(fields).toHaveLength(5);
  for (const field of fields) {
    const box = await field.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    // 16px or larger stops mobile Safari zooming the page on focus.
    const fontSize = await field.evaluate((element) => getComputedStyle(element).fontSize);
    expect(Number.parseFloat(fontSize)).toBeGreaterThanOrEqual(16);
  }
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});

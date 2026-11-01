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
  await expect(page.locator('.pp-field__hint, .pp-field__error')).toHaveCount(3);

  const filled = page.getByLabel('Short name');
  await expect(filled).toHaveValue('Berry pancakes');
  await expect(filled).toBeEditable();
  await expect(filled).not.toHaveAttribute('aria-invalid');

  await expect(page.getByLabel('Category')).toBeDisabled();

  await name.fill('Synthetic pancakes');
  await expect(name).toHaveValue('Synthetic pancakes');
});

// One Input (Harshita, 31 Oct): the form field wraps the design-system Input from ui/, and its own
// classes no longer reuse .pp-input, so the two stylesheets cannot clash.
test('each field renders the shared design-system Input inside its own wrapper', async ({
  page,
}) => {
  await page.goto(demo);
  await expect(page.locator('.pp-field')).toHaveCount(5);
  await expect(page.locator('.pp-field.pp-input, .pp-field .pp-input .pp-input')).toHaveCount(0);
  for (const field of await page.getByRole('textbox').all()) {
    await expect(field).toHaveClass(/(^|\s)pp-input(\s|$)/);
  }
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
    // Visible focus: either an outline or the design system's focus ring (a box-shadow).
    const focus = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outline: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
        ring: style.boxShadow !== 'none',
      };
    });
    expect(focus.outline || focus.ring).toBe(true);
  }
});

// Rania's spec (1 Nov): the input box is exactly 44px tall in every state, with 16px text on a 24px
// line height. Measured on the textbox itself, so the label and helper or error text are excluded.
test('every input box is 44px tall in every state, with 16px text on a 24px line height', async ({
  page,
}) => {
  await page.goto(demo);
  const measure = (field: import('@playwright/test').Locator) =>
    field.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    });
  const spec = { height: 44, fontSize: '16px', lineHeight: '24px' };

  const fields = await page.getByRole('textbox').all();
  // Default, filled, error and disabled fields are all on the demo page.
  await expect(page.locator('input[aria-invalid="true"]')).not.toHaveCount(0);
  await expect(page.locator('input:disabled')).not.toHaveCount(0);
  for (const field of fields) expect(await measure(field)).toEqual(spec);

  const name = page.getByLabel('Dish name');
  await name.hover();
  expect(await measure(name)).toEqual(spec);
  await name.focus();
  expect(await measure(name)).toEqual(spec);
  await name.fill('A very long dish name that fills the whole input box and keeps going');
  expect(await measure(name)).toEqual(spec);
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

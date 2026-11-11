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
  // An error replaces the helper text (Rania, 5 Nov), so only the error is announced.
  await expect(price).toHaveAccessibleDescription('Error: Enter a price');

  // The demo passes whitespace-only hint and error text here; it must be ignored.
  const note = page.getByLabel('Internal note');
  await expect(note).not.toHaveAttribute('aria-describedby');
  await expect(note).not.toHaveAttribute('aria-invalid');
  await expect(page.locator('.pp-field__hint, .pp-field__error')).toHaveCount(2);

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
  // Transitions off, so colours are read at their final value.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(demo);
  const order = ['Dish name', 'Price', 'Short name', 'Internal note'];
  await page.getByLabel(order[0] ?? '').focus();
  for (const [index, label] of order.entries()) {
    if (index > 0) await page.keyboard.press('Tab');
    const field = page.getByLabel(label);
    await expect(field).toBeFocused();
    // Visible focus (Rania, 6 Nov): the 1.5px edge turns Information/600 (#0B77BE), about 4.7:1
    // on the fill, with no extra halo. An invalid field keeps its error colour.
    const focus = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopColor, shadow: style.boxShadow };
    });
    const colour = label === 'Price' ? 'rgb(185, 28, 28)' : 'rgb(11, 119, 190)';
    expect(focus).toEqual({ border: colour, shadow: `${colour} 0px 0px 0px 0.5px inset` });
  }
});

test('an invalid field has a distinct keyboard focus cue while retaining its error', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 960 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(demo);
  const price = page.getByLabel('Price');
  const appearance = () =>
    price.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outline: style.outline,
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        outlineOffset: style.outlineOffset,
        border: style.borderTopColor,
        shadow: style.boxShadow,
        height: element.getBoundingClientRect().height,
      };
    });
  await page.getByLabel('Dish name').focus();
  const blurred = await appearance();
  await page.keyboard.press('Tab');
  await expect(price).toBeFocused();
  const focused = await appearance();
  expect(focused.outline).not.toBe(blurred.outline);
  expect(focused.outlineWidth).toBe('2px');
  expect(focused.outlineStyle).toBe('solid');
  expect(focused.outlineOffset).toBe('2px');
  expect(focused.border).toBe(blurred.border);
  expect(focused.shadow).toBe(blurred.shadow);
  expect(focused.height).toBe(44);
  await expect(price).toHaveAccessibleDescription('Error: Enter a price');
  await page.screenshot({
    path: testInfo.outputPath('textfield-focused-error-390.png'),
    fullPage: true,
  });
  await page.getByLabel('Dish name').focus();
  expect((await appearance()).outline).toBe(blurred.outline);
});

// Rania's spec (1 Nov): the input box is exactly 44px tall in every state, with 16px text on a 24px
// line height. Measured on the textbox itself, so the label and helper or error text are excluded.
// Rania's review (5 Nov): the label sits above the input, the helper or error text below it, and an
// error replaces the helper. The label is 14px on a 24px line height at weight 600.
test('helper and error text sit below the input, and an error replaces the helper', async ({
  page,
}) => {
  await page.goto(demo);
  const below = async (label: string, selector: string) => {
    const field = page.locator('.pp-field', { has: page.getByLabel(label) });
    const input = await field.getByRole('textbox').boundingBox();
    const text = await field.locator(selector).boundingBox();
    return (text?.y ?? 0) >= (input?.y ?? 0) + (input?.height ?? 0);
  };
  expect(await below('Dish name', '.pp-field__hint')).toBe(true);
  expect(await below('Price', '.pp-field__error')).toBe(true);

  const price = page.locator('.pp-field', { has: page.getByLabel('Price') });
  await expect(price.locator('.pp-field__error')).toHaveText('Error: Enter a price');
  await expect(price.locator('.pp-field__hint')).toHaveCount(0);
  await expect(price).not.toContainText('Numbers only');
});

test('field labels are 14px on a 24px line height at weight 600', async ({ page }) => {
  await page.goto(demo);
  const labels = await page.locator('.pp-field__label').all();
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    const style = await label.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        fontWeight: computed.fontWeight,
      };
    });
    expect(style).toEqual({ fontSize: '14px', lineHeight: '24px', fontWeight: '600' });
  }
});

// Rania's review (6 Nov): helper and error text 12px/16px at weight 400, indented 8px and 6px below
// the input; helper in on-surface-variant, error and the error border in color/error; label in
// on-surface.
test('helper, error and label text match the Figma colours, sizes and spacing', async ({
  page,
}) => {
  await page.goto(demo);
  const text = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        const input = element.parentElement?.querySelector('.pp-input');
        const gap = input
          ? Math.round(element.getBoundingClientRect().top - input.getBoundingClientRect().bottom)
          : null;
        return {
          color: style.color,
          size: style.fontSize,
          lineHeight: style.lineHeight,
          weight: style.fontWeight,
          indent: style.paddingInlineStart,
          gap,
        };
      });
  const small = { size: '12px', lineHeight: '16px', weight: '400', indent: '8px', gap: 6 };
  expect(await text('.pp-field__hint')).toEqual({ ...small, color: 'rgb(87, 85, 78)' });
  expect(await text('.pp-field__error')).toEqual({ ...small, color: 'rgb(185, 28, 28)' });
  expect((await text('.pp-field__label')).color).toBe('rgb(28, 26, 23)');
  const errorBorder = await page
    .locator('input[aria-invalid="true"]')
    .first()
    .evaluate((element) => getComputedStyle(element).borderTopColor);
  expect(errorBorder).toBe('rgb(185, 28, 28)');
});

// Rania's review (6 Nov), Figma Input / Text (Light): default border Neutral/500 at 80%, hover
// Neutral/500, focus Information/600 (focus wins over hover), disabled fill, border and text.
test('input border, fill and text colours follow each state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(demo);
  const look = (field: import('@playwright/test').Locator) =>
    field.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopColor, fill: style.backgroundColor, text: style.color };
    });
  const name = page.getByLabel('Dish name');
  const fill = 'rgb(250, 250, 249)';
  const text = 'rgb(28, 26, 23)';
  expect(await look(name)).toEqual({
    border: 'color(srgb 0.443137 0.45098 0.478431 / 0.8)',
    fill,
    text,
  });
  await name.hover();
  expect(await look(name)).toEqual({ border: 'rgb(113, 115, 122)', fill, text });
  await name.focus();
  expect(await look(name)).toEqual({ border: 'rgb(11, 119, 190)', fill, text });
  expect(await look(page.locator('input:disabled').first())).toEqual({
    border: 'rgb(212, 213, 216)',
    fill: 'rgb(231, 231, 233)',
    text: 'rgb(161, 163, 170)',
  });
});

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

// Rania's Figma update (5 Nov): 1.5px border, 12px radius, 16px side padding, in every state.
// Chrome draws borders in whole pixels, so the 1.5px edge is a 1px border plus a 0.5px inset shadow
// in the same colour, in every state.
test('every input box has a 1.5px edge, 12px radius and 16px side padding', async ({ page }) => {
  await page.goto(demo);
  const edge = (field: import('@playwright/test').Locator) =>
    field.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: style.borderLeftWidth,
        inset: style.boxShadow === `${style.borderLeftColor} 0px 0px 0px 0.5px inset`,
        radius: style.borderTopLeftRadius,
        padding: [style.paddingLeft, style.paddingRight],
      };
    });
  const spec = { border: '1px', inset: true, radius: '12px', padding: ['16px', '16px'] };
  const fields = await page.getByRole('textbox').all();
  await expect(page.locator('input[aria-invalid="true"]')).not.toHaveCount(0);
  await expect(page.locator('input:disabled')).not.toHaveCount(0);
  for (const field of fields) expect(await edge(field)).toEqual(spec);
  const name = page.getByLabel('Dish name');
  await name.hover();
  expect(await edge(name)).toEqual(spec);
  await name.focus();
  expect(await edge(name)).toEqual(spec);
});

test('Inter loads from the console itself in 400, 500 and 600, Latin only', async ({ page }) => {
  const fonts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fonts.push(request.url());
  });
  await page.goto(demo);
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.family.replace(/["']/g, '') === 'Inter' && face.status === 'loaded')
      .map((face) => face.weight)
      .sort(),
  );
  // The demo shows input text (400) and labels (600); 500 loads when a page uses it.
  expect(loaded).toEqual(expect.arrayContaining(['400', '600']));
  expect(fonts.length).toBeGreaterThan(0);
  for (const url of fonts) {
    expect(new URL(url).origin).toBe(new URL(demo).origin);
    expect(url).toMatch(/inter-latin-(400|500|600)-normal/);
  }
  const declared = await page.evaluate(
    () => [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'Inter').length,
  );
  expect(declared).toBe(3);
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

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const demo = 'http://127.0.0.1:5174/owner-dashboard.html';

test('existing desktop AI panel mounts all six synthetic states without API or model requests', async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType())) apiRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(demo);
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI', exact: true });
  await panel.getByText('Typed AI result preview', { exact: true }).click();
  const result = panel.getByRole('region', { name: 'Synthetic AI result' });
  const state = panel.getByLabel('Synthetic preview state');
  await expect(result.getByText('Synthetic AI preview', { exact: true })).toBeVisible();
  await expect(result.getByRole('heading', { name: 'Draft recommendation' })).toBeVisible();
  await expect(result).toContainText('Review required. This preview cannot apply changes.');
  for (const [value, copy] of [
    ['abstained', 'No recommendation'],
    ['loading', 'Loading the synthetic example'],
    ['error', 'The example could not be displayed'],
    ['insufficient-evidence', 'Not enough usable evidence'],
    ['withheld', 'Evidence withheld'],
  ]) {
    await state.selectOption(value as string);
    await expect(result).toContainText(copy as string);
    await expect(result.getByRole('heading', { name: 'Draft recommendation' })).toHaveCount(0);
  }
  await state.selectOption('recommendation');
  await expect(result.getByRole('heading', { name: 'Draft recommendation' })).toBeVisible();
  await expect(result.locator('button, form')).toHaveCount(0);
  expect(await result.innerText()).not.toMatch(/eligible.?sessions|cohort|987654/i);
  expect(apiRequests).toEqual([]);
});

test('the same component mounts in the existing narrow-screen drawer without overflowing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(demo);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Ask PeekaPlate AI' });
  await drawer.getByText('Typed AI result preview', { exact: true }).click();
  const result = drawer.getByRole('region', { name: 'Synthetic AI result' });
  await expect(result).toBeVisible();
  await drawer.getByLabel('Synthetic preview state').selectOption('withheld');
  await expect(result).toContainText('Evidence withheld. No recommendation is shown.');
  expect(await result.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await drawer.getByRole('button', { name: 'Close chat', exact: true }).click();
  await expect(drawer).toHaveCount(0);
});

test('preview controls work by keyboard and the component has no scoped accessibility violations', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(demo);
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI', exact: true });
  const toggle = panel.getByText('Typed AI result preview', { exact: true });
  await toggle.focus();
  await toggle.press('Enter');
  const state = panel.getByLabel('Synthetic preview state');
  await toggle.press('Tab');
  await expect(state).toBeFocused();
  await state.selectOption('recommendation');
  const { violations } = await new AxeBuilder({ page })
    .include('.aipanel .ai-preview-demo')
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

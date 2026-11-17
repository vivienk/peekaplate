import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`authored S05–S13 walkthrough and screenshots at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const destinations: string[] = [];
    page.on('request', (request) => {
      if (/supabase|workers\.dev|posthog|openai|ocr\.space/.test(request.url()))
        destinations.push(request.url());
    });
    const shot = async (name: string) => {
      await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(`${name}-${width}.png`),
        fullPage: !['s11-menu-verified', 's13-confirmation'].includes(name),
      });
    };
    await page.goto('http://127.0.0.1:5174/owner-onboarding.html?journey');
    await expect(page.getByText('Synthetic S05–S13 walkthrough.')).toBeVisible();
    await shot('s05-restaurant-details');
    await page.getByRole('textbox', { name: /Restaurant name/ }).fill('Ember & Stone');
    await page.getByRole('textbox', { name: /^City/ }).fill('San Francisco');
    await page.getByRole('textbox', { name: /Street address/ }).fill('100 Fictional Street');
    await page.getByRole('textbox', { name: /Phone number/ }).fill('(555) 234-5678');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await shot('s06-source-choice');
    const screen = page.getByRole('combobox', { name: 'Screen', exact: true });
    await screen.selectOption('s07-url');
    await page
      .getByRole('textbox', { name: 'Menu URL', exact: true })
      .fill('https://example.test/fictional-menu.pdf');
    await shot('s07-menu-link');
    await screen.selectOption('s07-upload');
    await shot('s07-menu-upload');
    await screen.selectOption('s08');
    await shot('s08-processing');
    await expect(page.getByRole('heading', { name: 'Your dishes', exact: true })).toBeVisible();
    await shot('s10-review-dishes');
    await page.getByRole('button', { name: 'Save and Exit', exact: true }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Add your menu' })).toContainText(
      'Added',
    );
    await screen.selectOption('s10');
    await page
      .getByRole('button', { name: /Edit .*|Review .*/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Edit dish', exact: true })).toBeVisible();
    await shot('s09-edit-dish');
    await page.getByRole('textbox', { name: /Serving Size/ }).fill('1 plate');
    await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
    await page.getByRole('button', { name: 'Complete verification', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Menu verified' })).toBeVisible();
    await shot('s11-menu-verified');
    await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
    await page
      .getByRole('checkbox', { name: 'Simulate team verification of restaurant details' })
      .check();
    await shot('s12-dashboard');
    await page.getByRole('button', { name: 'Review and publish', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Draft diner menu' })).toContainText(
      'Ember & Stone',
    );
    await shot('s13-preview');
    const phone = page.getByRole('region', { name: 'Draft diner menu', exact: true });
    await phone.locator('article').last().scrollIntoViewIfNeeded();
    await expect(phone.locator('article').last()).toBeInViewport();
    await phone
      .getByRole('heading', { name: 'Ember & Stone', exact: true })
      .scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Publish your menu?' })).toBeVisible();
    await shot('s13-confirmation');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Publish Menu', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Your menu is live' })).toBeVisible();
    await shot('s13-demo-success');
    await page.getByRole('button', { name: /^Go to dashboard$/i }).click();
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    expect(
      destinations,
      'preview walkthrough must not contact either analytics or a backend/provider',
    ).toEqual([]);
  });
}

// Rania's #213 review (Nov 17): Back returns where the owner came from, S06 → S05 stays in
// onboarding, focus moves to each new screen's heading, 48px Large buttons, 24px remove targets,
// and the agreed wording (S05 logo, S12 contact details, S08 failure).
test('onboarding Back, focus, button and wording fixes from the design review', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:5174/owner-onboarding.html?journey');
  const main = page.locator('main');
  await expect(main.getByRole('button', { name: 'Upload logo', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: /Restaurant name/ }).fill('Ember & Stone');
  await page.getByRole('textbox', { name: /^City/ }).fill('San Francisco');
  await page.getByRole('textbox', { name: /Street address/ }).fill('100 Fictional Street');
  await page.getByRole('textbox', { name: /Phone number/ }).fill('(555) 234-5678');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Each screen change moves focus to the new heading.
  const s06 = page.getByRole('heading', { level: 1, name: 'Choose how to add your menu' });
  await expect(s06).toBeFocused();
  for (const button of await main.locator('.pp-onboard__actions .pp-auth-btn').all())
    expect((await button.boundingBox())?.height).toBe(48);

  // S06 Back opens S05 in onboarding mode; saving it again continues to S06.
  await main.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant Details' })).toBeFocused();
  await expect(main.getByRole('button', { name: 'Go to dashboard', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(s06).toBeFocused();

  // S09 opened from S06 returns to S06, not S10.
  await page.getByText('Add manually', { exact: true }).click();
  await main.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add dish' })).toBeFocused();
  // Design QA #213: Add stays inactive until something is typed; the review box is the shared Checkbox.
  const addIngredient = page.getByRole('button', { name: 'Add ingredient', exact: true });
  await expect(addIngredient).toBeDisabled();
  await expect(
    page.getByLabel('I reviewed the AI-drafted text and ingredients. They are accurate.'),
  ).toHaveCSS('appearance', 'none');
  await page.getByPlaceholder('Add an ingredient').fill('Basil');
  await expect(addIngredient).toBeEnabled();
  await addIngredient.click();
  const remove = page.getByRole('button', { name: 'Remove Basil', exact: true });
  const box = await remove.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(24);
  expect(box?.height).toBeGreaterThanOrEqual(24);
  await main.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(s06).toBeFocused();

  // S08 failure text names only the buttons on screen.
  await page.getByRole('combobox', { name: 'Extraction answer' }).selectOption('failed');
  await page.getByRole('combobox', { name: 'Screen', exact: true }).selectOption('s08');
  await expect(main.getByText(/Choose Try another source to upload a different file/)).toBeVisible({
    timeout: 5000,
  });
  await expect(main.getByText(/Try again, use another source/)).toHaveCount(0);

  // S13 Publish Confirmation shows Rania's orange check above the title, with 48px buttons.
  await page.goto('http://127.0.0.1:5174/owner-menu-preview.html');
  await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish your menu?' });
  const icon = dialog.locator('.pp-menu-preview__dialog-icon');
  expect((await icon.boundingBox())?.width).toBe(96);
  const iconBox = await icon.boundingBox();
  const titleBox = await dialog.getByRole('heading').boundingBox();
  expect((titleBox?.y ?? 0) - ((iconBox?.y ?? 0) + (iconBox?.height ?? 0))).toBe(48);
  for (const button of await dialog.getByRole('button').all())
    expect((await button.boundingBox())?.height).toBe(48);
  await page.goto('http://127.0.0.1:5174/owner-onboarding.html?journey');

  // S12 step 1 names the fields S05 actually has.
  await page.getByRole('combobox', { name: 'Screen', exact: true }).selectOption('s12');
  await expect(main.getByText(/Name, address and contact details\./).first()).toBeVisible();
  await expect(main.getByText(/opening hours/)).toHaveCount(0);
});

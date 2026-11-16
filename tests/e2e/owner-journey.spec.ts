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
      await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: true });
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

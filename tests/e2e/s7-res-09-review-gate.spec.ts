import { expect, test } from '@playwright/test';

const onboardingJourney = 'http://127.0.0.1:5174/owner-onboarding.html?journey';
const reviewDemo = 'http://127.0.0.1:5174/review-dishes.html';

test('S08 automatic checks clarify unverified draft boundary and S10 blocks verification while incomplete dishes remain', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(onboardingJourney);

  const screen = page.getByRole('combobox', { name: 'Screen', exact: true });
  await screen.selectOption('s08');
  await expect(page.getByRole('heading', { level: 1, name: 'Processing your menu' })).toBeVisible();
  await expect(
    page.getByText(
      'automatically checking extracted menu information for completeness and confidence',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('No items will go live or be published without your explicit confirmation.'),
  ).toBeVisible();

  await screen.selectOption('s10');
  await expect(page.getByRole('heading', { level: 1, name: 'Your dishes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete verification' })).toHaveCount(0);
});

test('S10 verification requires all dishes ready and never auto-publishes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const destinations: string[] = [];
  page.on('request', (request) => {
    if (/supabase|workers\.dev|posthog|openai|ocr\.space/.test(request.url())) {
      destinations.push(request.url());
    }
  });

  await page.goto(reviewDemo);
  const complete = page.getByRole('button', { name: 'Complete verification' });
  await expect(complete).toHaveCount(0);

  await page.getByLabel('Menu state').selectOption('ready');
  await expect(complete).toBeEnabled();
  await complete.click();

  const dialog = page.getByRole('dialog', { name: 'Menu verified' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'Your menu details are confirmed. Verification does not publish your menu.',
  );

  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review and publish', exact: true })).toBeVisible();
  expect(destinations).toEqual([]);
});

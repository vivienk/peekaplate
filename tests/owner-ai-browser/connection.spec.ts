import { expect, test } from '@playwright/test';

test('dashboard traverses the real local API adapter and withholds CRM suggestions', async ({
  page,
}) => {
  const outbound: string[] = [];
  page.on('request', (request) => outbound.push(request.url()));
  await page.goto('http://127.0.0.1:5174/owner-dashboard.html');
  const panel = page.getByRole('region', { name: 'Connected owner analysis' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Suggested review' })).toBeVisible();
  await expect(panel).toContainText('open rate: 50.0%');
  await expect(panel).toContainText('No menu changes or customer messages are sent.');
  await panel.getByLabel('Review focus').selectOption('crm');
  await expect(panel.getByText('open rate: 50.0%')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel).toContainText('This report has no customer-retention or CRM evidence.');
  expect(outbound.every((url) => new URL(url).hostname === '127.0.0.1')).toBe(true);
  await page.screenshot({ path: 'test-results/owner-ai-connected.png', fullPage: true });
});

test('mobile drawer shows connected suggestions and discards failed responses', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5174/owner-dashboard.html');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask PeekaPlate AI' });
  await dialog.getByRole('button', { name: 'Review report' }).click();
  await expect(dialog.getByRole('heading', { name: 'Suggested review' })).toBeVisible();
  await page.route('**/ai/analysis', (route) =>
    route.fulfill({ status: 503, body: 'provider-private-error' }),
  );
  await dialog.getByRole('button', { name: 'Review report' }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be reviewed');
  await expect(dialog.getByRole('heading', { name: 'Suggested review' })).toHaveCount(0);
  await expect(dialog.getByText('provider-private-error')).toHaveCount(0);
});

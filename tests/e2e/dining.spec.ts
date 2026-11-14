import { expect, test } from '@playwright/test';

const base = process.env.PEEKAPLATE_UPLOAD_URL || 'http://127.0.0.1:5175/';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const menu = {
  locationId: 'noka-oakland',
  venueId: id(1),
  menuId: id(2),
  publicationId: id(3),
  currency: 'USD',
  acceptingOrders: true,
  items: [
    {
      id: id(4),
      revisionId: id(5),
      name: 'Synthetic test ramen',
      description: 'Browser test data, not restaurant content',
      unitCents: 2100,
      image: null,
    },
  ],
};
test('Quest home shows sourced restaurants; missing backend never claims orders work', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla OculusBrowser/35' }),
  );
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Find your next favourite.' })).toBeVisible();
  await expect(page.locator('[data-location]')).toHaveCount(11);
  await page.getByLabel('Restaurant brand').selectOption('Son & Garden');
  await expect(page.locator('[data-location]')).toHaveCount(2);
  await page.getByLabel('Restaurant brand').selectOption('');
  await page.screenshot({ path: '/private/tmp/quest-dining-map.png', fullPage: true });
  await page.locator('[data-location="noka-oakland"]').click();
  await expect(page.getByText('Online ordering isn’t connected yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View restaurant menu' })).toHaveAttribute(
    'href',
    'https://qr.codes/GMn9C8',
  );
  await expect(page.getByRole('button', { name: 'Submit order without payment' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restaurants' }).click();
  await expect(page.locator('[data-location]')).toHaveCount(11);
});
test('menu to unpaid submission preserves cart on failure and reuses command id', async ({
  page,
}) => {
  await page.route('**/public/dining/locations/noka-oakland/menu', (r) =>
    r.fulfill({ json: menu }),
  );
  const commands: string[] = [];
  await page.route('**/public/dining/locations/noka-oakland/orders', async (r) => {
    commands.push(r.request().postDataJSON().commandId);
    if (commands.length === 1) return r.fulfill({ status: 503, json: { error: 'unavailable' } });
    return r.fulfill({
      status: 201,
      json: {
        orderId: id(9),
        locationId: 'noka-oakland',
        status: 'submitted',
        paymentStatus: 'unpaid',
        fulfillment: 'pickup',
        currency: 'USD',
        subtotalCents: 4200,
        createdAt: new Date().toISOString(),
      },
    });
  });
  await page.goto(base + '?experience=quest');
  await page.locator('[data-location="noka-oakland"]').click();
  await page.getByLabel('Quantity for Synthetic test ramen').fill('2');
  await page.getByLabel('Quantity for Synthetic test ramen').press('Tab');
  await page.getByRole('button', { name: 'View dish & portion' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic test ramen' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to menu', exact: true }).click();
  await expect(page.getByLabel('Quantity for Synthetic test ramen')).toHaveValue('2');
  await page.getByRole('button', { name: 'Review order' }).click();
  await page.getByRole('button', { name: 'Submit order without payment' }).click();
  await expect(page.locator('[data-result]')).toContainText('Order not confirmed');
  await page.getByRole('button', { name: 'Submit order without payment' }).click();
  await expect(page.locator('[data-result]')).toContainText('Request received');
  await expect(page.locator('[data-result]')).toContainText('Unpaid');
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(commands[1]);
});

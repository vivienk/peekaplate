import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

// S3-RES-03: the dashboard's Report data page against the report API's answers. Owner sign-in
// (S4-FE-04) and the API's console CORS do not exist yet, so this test seam supplies the two API
// settings and a stand-in token in the served page module, and answers the API request itself.
// The real fetch, schema check and page states run unchanged.
const demo = 'http://127.0.0.1:5174/owner-dashboard.html';
const API = 'http://127.0.0.1:5174/test-api';

// The saved Uneeza report payload, read from its source file as plain data.
const savedSource = readFileSync(
  new URL('../../frontend/console/src/owner-dashboard/uneeza-report.ts', import.meta.url),
  'utf8',
);
const REPORT = JSON.parse(
  Function(
    `return JSON.stringify(${savedSource.slice(savedSource.indexOf('{'), savedSource.lastIndexOf('}') + 1)})`,
  )(),
);
const VENUE: string = REPORT.venue_id;

async function openLiveReport(
  page: Page,
  answer: (attempt: number) => { status: number; body?: unknown },
) {
  await page.route('**/src/owner-dashboard/report-data.tsx*', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replaceAll('import.meta.env.VITE_PUBLIC_API_URL', JSON.stringify(API))
      .replaceAll('import.meta.env.VITE_OWNER_REPORT_VENUE_ID', JSON.stringify(VENUE))
      .replace(
        /(async function getOwnerAccessToken\(\)\s*\{\s*)return null;/,
        '$1return "test-owner-token";',
      );
    if (!body.includes('"test-owner-token"')) throw new Error('token seam did not apply');
    await route.fulfill({ response, body });
  });
  const requests: { url: string; authorization: string | null }[] = [];
  await page.route(`${API}/**`, async (route) => {
    requests.push({
      url: route.request().url(),
      authorization: await route.request().headerValue('authorization'),
    });
    const { status, body } = answer(requests.length);
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body ?? {}),
    });
  });
  await page.goto(demo);
  await page.getByRole('button', { name: 'Report data' }).first().click();
  return requests;
}

test('Report data loads the live report with the owner token and shows its states', async ({
  page,
}) => {
  const requests = await openLiveReport(page, () => ({ status: 200, body: REPORT }));
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByText('Synthetic test data from the report API')).toBeVisible();
  await expect(page.getByText('Saved copy')).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Bowl/ })).toContainText('Not measurable');
  expect(requests).toEqual([
    {
      url: `${API}/api/v1/venues/${VENUE}/analytics/dishes?source=synthetic`,
      authorization: 'Bearer test-owner-token',
    },
  ]);
});

test('a failed load offers Try again, and the retry shows the report', async ({ page }) => {
  const requests = await openLiveReport(page, (attempt) =>
    attempt === 1 ? { status: 500 } : { status: 200, body: REPORT },
  );
  await expect(page.getByRole('alert')).toContainText('couldn’t load the report');
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(requests).toHaveLength(2);
});

test('access denied and an unverifiable report show no numbers', async ({ page }) => {
  await openLiveReport(page, () => ({ status: 403 }));
  await expect(page.getByText('don’t have access')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);

  const other = { ...REPORT, venue_id: '00000000-0000-4000-8000-000000000123' };
  await page.unrouteAll({ behavior: 'wait' });
  await openLiveReport(page, () => ({ status: 200, body: other }));
  await expect(page.getByText('couldn’t verify this report')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('without the API settings the page shows the labelled saved copy', async ({ page }) => {
  await page.goto(demo);
  await page.getByRole('button', { name: 'Report data' }).first().click();
  await expect(page.getByText('Saved copy of a report')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
});

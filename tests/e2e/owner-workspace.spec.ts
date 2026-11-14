import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { UNEEZA_REPORT } from '../../frontend/console/src/owner-dashboard/uneeza-report';

const origin = 'http://127.0.0.1:5174';
const api = 'https://peekaplate-api-staging.vxkong.workers.dev';
const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const venue = {
  venueId: '00000000-0000-4000-8000-000000000123',
  name: 'Synthetic Bridge Cafe',
  permission: 'owner',
};
const otherVenue = {
  venueId: '33333333-3333-4333-8333-333333333333',
  name: 'Other Synthetic Cafe',
  permission: 'owner',
};
const user = (id = ownerId) => ({
  id,
  aud: 'authenticated',
  role: 'authenticated',
  email: id === ownerId ? 'owner@example.test' : 'other@example.test',
  email_confirmed_at: '2026-11-11T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-11-11T00:00:00Z',
});
const token = (id: string) =>
  `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.c3ludGhldGlj`;
const session = (id: string) => ({
  access_token: token(id),
  refresh_token: `synthetic-refresh-${id}`,
  token_type: 'bearer',
  expires_in: 3600,
  user: user(id),
});

function subject(authorization: string | undefined) {
  try {
    return JSON.parse(
      Buffer.from(
        authorization?.replace(/^Bearer /i, '').split('.')[1] ?? '',
        'base64url',
      ).toString(),
    ).sub as string;
  } catch {
    return '';
  }
}

async function fixture(context: BrowserContext) {
  const state = {
    venues: [venue],
    reportStatus: 200,
    denyIdentity: false,
    invalidActor: false,
    delayMembership: false,
    releaseMembership: () => {},
    delayReport: false,
    releaseReport: () => {},
    apiCalls: [] as Array<{ path: string; actor: string }>,
  };
  await context.route('https://auth-fixture.supabase.co/auth/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/').at(-1);
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*' },
      });
    let actor = subject(request.headers().authorization) || ownerId;
    if (path === 'token' && request.postDataJSON()?.email === 'other@example.test') actor = otherId;
    const status = path === 'user' && state.denyIdentity ? 401 : 200;
    await route.fulfill({
      status,
      json:
        status === 401
          ? { code: 'bad_jwt', message: 'Synthetic expired identity' }
          : path === 'token'
            ? session(actor)
            : path === 'user'
              ? user(actor)
              : {},
      headers: { 'Access-Control-Allow-Origin': origin, 'X-Supabase-Api-Version': '2024-01-01' },
    });
  });
  await context.route(`${api}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*' },
      });
    const actor = subject(request.headers().authorization);
    state.apiCalls.push({ path: url.pathname, actor });
    if (url.pathname === '/staff/venues') {
      const body = {
        actorId: state.invalidActor ? otherId : actor,
        venues: actor === otherId ? [otherVenue] : state.venues,
      };
      if (state.delayMembership)
        await new Promise<void>((resolve) => {
          state.releaseMembership = resolve;
        });
      await route
        .fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': origin } })
        .catch(() => {});
    } else {
      if (state.delayReport)
        await new Promise<void>((resolve) => {
          state.releaseReport = resolve;
        });
      await route.fulfill({
        status: state.reportStatus,
        json:
          state.reportStatus === 200
            ? { ...UNEEZA_REPORT, venue_id: url.pathname.split('/')[4] }
            : { error: 'synthetic_denial' },
        headers: { 'Access-Control-Allow-Origin': origin },
      });
    }
  });
  return state;
}

async function signIn(page: Page, email = 'owner@example.test') {
  await page.goto(`${origin}/owner-auth.html`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('real SDK sign-in opens the server restaurant shell and authenticated report', async ({
  context,
  page,
}, testInfo) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  await expect(page.getByRole('heading', { name: 'Restaurant workspace' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('owner-workspace-desktop.png'),
    fullPage: true,
  });
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'AI Insight Report', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(
    page.getByText('Synthetic test data from the report API. Not real diners.'),
  ).toBeVisible();
  expect(state.apiCalls.every((call) => call.actor === ownerId)).toBe(true);
  await page.reload();
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

test('new accounts without restaurant membership see an honest empty state', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [];
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
  expect(state.apiCalls.map((call) => call.path)).toEqual(['/staff/venues']);
});

test('multiple restaurants require selection and a switch removes the old report', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [venue, otherVenue];
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Choose a restaurant' })).toBeVisible();
  await page.getByLabel('Restaurant', { exact: true }).selectOption(venue.venueId);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByLabel('Restaurant', { exact: true }).selectOption(otherVenue.venueId);
  await expect(page.locator('.owner-identity__name')).toHaveText(otherVenue.name);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('editor access does not enable owner-only reports', async ({ context, page }) => {
  const state = await fixture(context);
  state.venues = [{ ...venue, permission: 'editor' }];
  await signIn(page);
  await expect(page.getByText('Access: Editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dish performance', exact: true })).toHaveCount(0);
});

test('a response for another actor never opens its restaurant', async ({ context, page }) => {
  const state = await fixture(context);
  state.invalidActor = true;
  await signIn(page);
  await expect(
    page.getByRole('heading', { name: 'Restaurant workspace unavailable' }),
  ).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

test('report revocation refreshes membership and clears private state', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  state.reportStatus = 403;
  state.venues = [];
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('an expired identity removes the shell before an API request can use it', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  state.denyIdentity = true;
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
  expect(state.apiCalls.map((call) => call.path)).toEqual(['/staff/venues']);
});

test('sign-out while membership is pending cannot restore a late restaurant response', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.delayMembership = true;
  await signIn(page);
  await expect.poll(() => state.apiCalls.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  state.releaseMembership();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

test('a different account signing in in another tab replaces old state and a late report', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  state.delayReport = true;
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect
    .poll(() => state.apiCalls.some((call) => call.path.endsWith('/analytics/dishes')))
    .toBe(true);
  const other = await context.newPage();
  await other.goto(origin);
  expect(
    await other.evaluate(async () => {
      const path = '/src/auth/supabase-auth.ts';
      const { connectOwnerAuth } = await import(path);
      const auth = connectOwnerAuth({
        url: 'https://auth-fixture.supabase.co',
        publishableKey: 'sb_publishable_synthetic_fixture_only',
        confirmationUrl: `${location.origin}/auth-confirm.html`,
      });
      return (
        await auth.service.signIn({ email: 'other@example.test', password: 'synthetic-password' })
      ).kind;
    }),
  ).toBe('signed_in');
  await expect(page.locator('.owner-identity__name')).toHaveText(otherVenue.name);
  state.releaseReport();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: venue.name })).toHaveCount(0);
});

test('workspace supports keyboard, narrow screens and accessible labels', async ({
  context,
  page,
}, testInfo) => {
  await fixture(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  await page.getByLabel('Restaurant', { exact: true }).focus();
  await expect(page.getByLabel('Restaurant', { exact: true })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('owner-workspace-mobile.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

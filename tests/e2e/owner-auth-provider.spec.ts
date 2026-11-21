import { expect, type Page, type Route, test } from '@playwright/test';
import { OWNER_PAGE_PATHS } from '../../frontend/console/src/owner/routes';
import { UNEEZA_REPORT } from '../../frontend/console/src/owner-dashboard/uneeza-report';

const origin = 'http://127.0.0.1:5174';
const productionOrigin = 'https://peekaplate.app';
async function serveConsole(route: Route) {
  const { pathname, search } = new URL(route.request().url());
  const response = await route.fetch({ url: `${origin}${pathname}${search}` });
  await route.fulfill({ response });
}
const email = 'owner@example.test';
const user = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email,
  email_confirmed_at: '2026-11-11T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-11-11T00:00:00Z',
};
const session = {
  access_token: `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.c3ludGhldGlj`,
  refresh_token: 'synthetic-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  user,
};

async function provider(
  page: Page,
  overrides: Record<string, { status?: number; body: unknown }> = {},
  appOrigin = origin,
) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  await page.route('https://auth-fixture.supabase.co/auth/v1/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: { 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Headers': '*' },
      });
      return;
    }
    const path = new URL(request.url()).pathname.split('/').at(-1)!;
    const body = request.postDataJSON() as Record<string, unknown> | null;
    calls.push({ url: request.url(), body });
    const answer = overrides[`${path}:${body?.auth_code}`] ??
      overrides[`${path}:${request.method()}`] ??
      overrides[path] ?? {
        body:
          path === 'token'
            ? session
            : path === 'user'
              ? user
              : path === 'signup'
                ? { user, session: null }
                : {},
      };
    await route.fulfill({
      status: answer.status ?? 200,
      json: answer.body,
      headers: {
        'Access-Control-Allow-Origin': appOrigin,
        'X-Supabase-Api-Version': '2024-01-01',
        'Access-Control-Expose-Headers': 'X-Supabase-Api-Version',
      },
    });
  });
  return calls;
}

async function signInScreen(page: Page, appOrigin = origin) {
  await page.goto(`${appOrigin}/owner-auth.html`);
  await enterEmail(page);
}

async function enterEmail(page: Page) {
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}

async function signup(page: Page, appOrigin = origin) {
  await signInScreen(page, appOrigin);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Full name').fill('Synthetic Owner');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('checkbox', { name: /I agree/ }).check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

test('signed-out owners return to the sign-in path from each production workspace URL', async ({
  page,
}) => {
  await page.route(`${productionOrigin}/**`, serveConsole);
  const calls = await provider(page, {}, productionOrigin);
  let workspaceRequests = 0;
  await page.route('https://api.peekaplate.app/**', async (route) => {
    workspaceRequests++;
    await route.abort();
  });
  for (const path of Object.values(OWNER_PAGE_PATHS)) {
    await page.goto(`${productionOrigin}${path}`);
    await expect(page).toHaveURL(`${productionOrigin}/owner-auth`);
    await expect(page.getByLabel('Email address')).toBeVisible();
  }
  expect(calls).toEqual([]);
  expect(workspaceRequests).toBe(0);
});

test('production deep links resume after sign-in and keep orientation through browser history', async ({
  page,
}) => {
  await page.route(`${productionOrigin}/**`, serveConsole);
  await provider(page, {}, productionOrigin);
  const venue = { venueId: user.id, name: 'Synthetic Corner Cafe', permission: 'owner' };
  let published = true;
  let setupReads = 0;
  let reportReads = 0;
  let workspaceReads = 0;
  await page.route('https://api.peekaplate.app/**', async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    const headers = {
      'Access-Control-Allow-Origin': productionOrigin,
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    expect(route.request().headers().authorization).toBe(`Bearer ${session.access_token}`);
    let json: unknown;
    if (pathname === '/staff/venues') {
      workspaceReads++;
      json = { actorId: user.id, venues: [venue] };
    } else if (pathname.endsWith('/setup')) {
      setupReads++;
      json = {
        venueId: venue.venueId,
        restaurantName: venue.name,
        detailsStatus: 'verified',
        menuAdded: true,
        menuVerified: true,
        published,
      };
    } else if (pathname.endsWith('/profile')) json = { profile: null };
    else if (pathname.endsWith('/jobs')) json = { jobs: [] };
    else if (pathname.endsWith('/drafts')) json = { drafts: [] };
    else if (pathname.endsWith('/owner-insight-actions')) {
      json = { schemaVersion: 1, actions: [] };
    } else if (pathname.endsWith('/analytics/dishes')) {
      expect(searchParams.get('source')).toBe('production');
      reportReads++;
      json = {
        ...UNEEZA_REPORT,
        source: 'production',
        venue_id: venue.venueId,
        dishes: UNEEZA_REPORT.dishes.map((dish, index) =>
          index === 0 ? { ...dish, name: 'Fixture lentil soup' } : dish,
        ),
        report_metadata: {
          ...UNEEZA_REPORT.report_metadata,
          calculation_version: 'production.v1',
        },
      };
    } else return route.fulfill({ status: 404, headers, json: { error: 'unexpected_path' } });
    await route.fulfill({ status: 200, headers, json });
  });
  await page.goto(`${productionOrigin}/dish-performance?next=https://example.invalid`);
  await expect(page).toHaveURL(`${productionOrigin}/owner-auth`);
  expect(workspaceReads).toBe(0);
  await enterEmail(page);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${productionOrigin}/dish-performance`);
  await expect(page.getByRole('table').getByText('Fixture lentil soup')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  const visit = async (label: string, path: string, heading: string) => {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await expect(page).toHaveURL(`${productionOrigin}${path}`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  };
  const mainPane = page.locator('.owner-main');
  await mainPane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => mainPane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await visit('Overview', '/overview', 'How your menu did this period');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page).toHaveTitle('PeekaPlate · Overview');
  await expect.poll(() => mainPane.evaluate((element) => element.scrollTop)).toBe(0);
  await visit('AI Insight Report', '/ai-insight-report', 'Menu activity report');
  await visit('Dish performance', '/dish-performance', 'What diners did with each dish');
  await expect(page.getByRole('table').getByText('Fixture lentil soup')).toBeVisible();
  expect(reportReads).toBe(1);
  await visit('Actions', '/actions', 'What you decided to do');
  await visit('Menu', '/menu', 'Your dishes');
  expect(setupReads).toBe(1);
  expect(workspaceReads).toBe(1);

  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  const dishName = page.getByRole('textbox', { name: 'Dish name' });
  await dishName.fill('Unsaved route test');
  const cancel = page.waitForEvent('dialog').then((dialog) => dialog.dismiss());
  await page.evaluate(() => window.history.back());
  await cancel;
  await expect(page).toHaveURL(`${productionOrigin}/menu`);
  await expect(dishName).toHaveValue('Unsaved route test');
  const discard = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await page.evaluate(() => window.history.back());
  await discard;
  await expect(page).toHaveURL(`${productionOrigin}/actions`);
  await expect(page.getByRole('heading', { name: 'What you decided to do' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Your dishes' })).toBeVisible();
  await page.goto(`${productionOrigin}/dish-performance`);
  await expect(page.getByRole('table')).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(`${productionOrigin}/dish-performance`);
  await expect(page.getByRole('table')).toBeVisible();

  published = false;
  await page.reload();
  await expect(page).toHaveURL(`${productionOrigin}/restaurant-setup`);
  await expect(nav.getByRole('button', { name: 'Dish performance' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  expect(reportReads).toBe(3);

  await page.getByLabel('Owner account').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${productionOrigin}/owner-auth`);
  await expect(page).toHaveTitle('PeekaPlate · Owner sign in');
  published = true;
  await enterEmail(page);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${productionOrigin}/restaurant-setup`);
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  expect(reportReads).toBe(3);
});

test('production confirms to sign-in, opens S05, resumes saves and retains the authorized workspace', async ({
  page,
}) => {
  await page.route(`${productionOrigin}/**`, serveConsole);
  const calls = await provider(
    page,
    {
      'token:synthetic-rejected': { status: 400, body: { code: 'flow_state_not_found' } },
    },
    productionOrigin,
  );
  const venue = {
    venueId: '30224700-944a-48af-8c6d-d1d7578b229a',
    name: 'Riverview Cafe',
    permission: 'owner',
  };
  const otherVenue = {
    ...venue,
    venueId: '0e200b46-e52c-43b2-8522-71ff3bb523f0',
    name: 'Willow Cafe',
  };
  const details = {
    name: venue.name,
    city: 'Phoenix',
    street: '100 Main Street',
    line2: '',
    phone: '(555) 123-4567',
    email: '',
    photoId: null,
  };
  const venues: (typeof venue)[] = [];
  const creationRequests: unknown[] = [];
  const profileRequests: unknown[] = [];
  const profiles = new Map<string, { version: number; fields: typeof details; status: string }>();
  await page.route('https://api.peekaplate.app/**', async (route) => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': productionOrigin,
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const pathname = new URL(request.url()).pathname;
    let json: unknown;
    let status = 200;
    if (pathname === '/staff/venues') {
      if (request.method() === 'POST') {
        creationRequests.push(request.postDataJSON());
        if (!venues.length) venues.push(venue);
        status = creationRequests.length === 1 ? 503 : 200;
        json = { venue };
      } else json = { actorId: user.id, venues };
    } else {
      const venueId = pathname.split('/')[2]!;
      const selected = venues.find((item) => item.venueId === venueId);
      if (!selected) return route.fulfill({ status: 403, headers, json: { error: 'forbidden' } });
      if (pathname.endsWith('/profile')) {
        if (request.method() === 'PUT') {
          const input = request.postDataJSON();
          profileRequests.push(input);
          profiles.set(venueId, { version: 1, status: 'verified', fields: input.fields });
          status = profileRequests.length === 1 ? 503 : 200;
        }
        json = { profile: profiles.get(venueId) ?? null };
      } else if (pathname.endsWith('/setup')) {
        json = {
          venueId,
          restaurantName: selected.name,
          detailsStatus: profiles.get(venueId)?.status ?? 'missing',
          menuAdded: false,
          menuVerified: false,
          published: false,
        };
      } else if (pathname.endsWith('/jobs')) json = { jobs: [] };
      else if (pathname.endsWith('/drafts')) json = { drafts: [] };
    }
    await route.fulfill({ status, json, headers });
  });

  await signup(page, productionOrigin);
  await page.goto(`${productionOrigin}/auth-confirm.html?code=synthetic-rejected`);
  await expect(
    page.getByRole('heading', { name: 'This confirmation link cannot be used' }),
  ).toBeVisible();
  const verification = Promise.withResolvers<void>();
  await page.route('https://auth-fixture.supabase.co/auth/v1/user', async (route) => {
    await verification.promise;
    await route.fallback();
  });
  await page.goto(`${productionOrigin}/auth-confirm?code=synthetic-production-code`);
  await expect(page).toHaveURL(`${productionOrigin}/auth-confirm`);
  await expect(page.getByRole('status')).toHaveText('Confirming your email…');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  verification.resolve();
  await expect(page).toHaveURL(`${productionOrigin}/owner-auth`);
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-fixture-auth-token'))).toBeNull();
  expect(creationRequests).toHaveLength(0);
  await page.goto(`${productionOrigin}/dish-performance`);
  await expect(page).toHaveURL(`${productionOrigin}/owner-auth`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Restaurant Details' })).toBeFocused();
  await expect(page).toHaveURL(`${productionOrigin}/restaurant-setup`);
  await expect(page.getByText('Create test restaurant')).toHaveCount(0);
  expect(creationRequests).toHaveLength(0);
  const name = page.getByLabel('Restaurant name');
  await name.fill(details.name);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new BroadcastChannel('sb-auth-fixture-auth-token');
        channel.onmessage = ({ data }) => {
          if (data.event === 'SIGNED_IN') {
            channel.close();
            resolve();
          }
        };
        window.dispatchEvent(new Event('visibilitychange'));
      }),
  );
  await expect(name).toHaveValue(details.name);
  await page.getByLabel('City').fill(details.city);
  await page.getByLabel('Street address').fill(details.street);
  await page.getByLabel('Phone number').fill(details.phone);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await name.fill('x'.repeat(161));
  await expect(page.getByText('Use 160 characters or fewer')).toBeVisible();
  await expect(save).toBeDisabled();
  expect(creationRequests).toHaveLength(0);
  await name.fill(details.name);
  await page.evaluate(async () => {
    const key = 'sb-auth-fixture-auth-token';
    const saved = localStorage.getItem(key);
    if (!saved) throw new Error('Fixture session was not persisted');
    const prior = JSON.parse(saved);
    const next = { ...prior, access_token: prior.access_token.replace(/[^.]+$/, 'cm90YXRlZA') };
    localStorage.setItem(key, JSON.stringify(next));
    const channel = new BroadcastChannel(key);
    channel.postMessage({ event: 'TOKEN_REFRESHED', session: next });
    channel.close();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(name).toHaveValue(details.name);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('We couldn’t save your restaurant details')).toBeVisible();
  await save.click();
  await expect(page.getByText('We couldn’t save your restaurant details')).toBeVisible();
  await save.click();
  await expect(page.getByRole('heading', { name: 'Choose how to add your menu' })).toBeFocused();
  await expect(
    page.getByText('Restaurant details saved. Verified. This does not publish your menu.'),
  ).toBeVisible();
  expect(creationRequests).toEqual([
    { name: venue.name, commandId: expect.any(String) },
    creationRequests[0],
  ]);
  expect(profileRequests).toEqual([
    { expectedVersion: 0, fields: details, commandId: expect.any(String) },
    profileRequests[0],
  ]);
  const exchanges = calls.filter((call) => call.body?.auth_code === 'synthetic-production-code');
  expect(exchanges).toHaveLength(1);
  expect(exchanges[0]?.body?.code_verifier).toEqual(expect.stringMatching(/\S+/));
  expect(calls.filter((call) => new URL(call.url).pathname.endsWith('/logout'))).toHaveLength(1);

  venues.push(otherVenue);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose a restaurant' })).toHaveCount(0);
  await page.getByLabel('Owner account').click();
  const picker = page.getByRole('combobox', { name: 'Restaurant', exact: true });
  await expect(picker).toHaveValue(venue.venueId);
  await picker.selectOption(otherVenue.venueId);
  await expect(page.getByRole('heading', { name: 'Restaurant Details' })).toBeVisible();
  await expect(page.getByLabel('Restaurant name')).toHaveValue(otherVenue.name);
  await page.goto(`${productionOrigin}/auth-confirm.html?code=synthetic-production-code`);
  await expect(
    page.getByRole('heading', { name: 'This confirmation link cannot be used' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  expect(creationRequests).toHaveLength(2);
});

for (const transition of ['popstate', 'back-forward cache'] as const) {
  test(`interrupting production confirmation with ${transition} still requires sign-in`, async ({
    page,
  }) => {
    await page.route(`${productionOrigin}/**`, serveConsole);
    await provider(page, {}, productionOrigin);
    await signup(page, productionOrigin);
    const response = Promise.withResolvers<void>();
    const verification = page.waitForRequest('https://auth-fixture.supabase.co/auth/v1/user');
    await page.route('https://auth-fixture.supabase.co/auth/v1/user', async (route) => {
      await response.promise;
      await route.fallback();
    });
    await page.goto(`${productionOrigin}/auth-confirm.html?code=synthetic-interrupted`);
    await verification;
    await page.evaluate((event) => {
      if (event === 'popstate') window.dispatchEvent(new PopStateEvent('popstate'));
      else {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      }
    }, transition);
    response.resolve();
    await expect(
      page.getByRole('heading', { name: 'This confirmation link cannot be used' }),
    ).toBeVisible();
    const saved = await page.evaluate(() => localStorage.getItem('sb-auth-fixture-auth-token'));
    expect(saved).toBeNull();
    await page.goto(`${productionOrigin}/owner-auth.html`);
    await expect(page.getByLabel('Email address')).toBeVisible();
  });
}

test('production confirmation discards a recovery-purpose exchange', async ({ page }) => {
  await page.route(`${productionOrigin}/**`, serveConsole);
  const calls = await provider(page, {}, productionOrigin);
  await recoveryEmail(page, productionOrigin);
  await page.goto(`${productionOrigin}/auth-confirm.html?code=synthetic-recovery-on-confirmation`);
  await expect(
    page.getByRole('heading', { name: 'This confirmation link cannot be used' }),
  ).toBeVisible();
  expect(
    calls.filter((call) => call.body?.auth_code === 'synthetic-recovery-on-confirmation'),
  ).toHaveLength(1);
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('Pages clean confirmation callback keeps PKCE and strips the code', async ({ page }) => {
  const calls = await provider(page);
  await signup(page);
  await page.goto(`${origin}/auth-confirm?code=synthetic-clean-code`);
  await expect(page).toHaveURL(`${origin}/auth-confirm`);
  await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
  expect(calls.filter((call) => call.body?.auth_code)).toHaveLength(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email confirmed', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.body?.auth_code === 'synthetic-clean-code')).toHaveLength(1);
});

test('Pages clean recovery callback opens only the recovery form', async ({ page }) => {
  const calls = await provider(page);
  await recoveryEmail(page);
  await page.goto(`${origin}/auth-reset?code=synthetic-clean-recovery`);
  await expect(page).toHaveURL(`${origin}/auth-reset`);
  await expect(page.getByRole('heading', { name: 'Open password reset' })).toBeVisible();
  expect(calls.filter((call) => call.body?.auth_code)).toHaveLength(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  expect(calls.filter((call) => call.body?.auth_code === 'synthetic-clean-recovery')).toHaveLength(
    1,
  );
  expect(calls.some((call) => call.url.endsWith('/user') && call.body?.password)).toBe(false);
});

test('neutral entry makes no lookup, confirmed sign-in restores and signs out', async ({
  page,
}) => {
  const calls = await provider(page);
  await signInScreen(page);
  expect(calls).toHaveLength(0);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
  await expect(page.getByText(/grants no restaurant access/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
});

test('signup creates PKCE, callback strips secrets, confirms and returns to sign in', async ({
  page,
}) => {
  const calls = await provider(page);
  await signup(page);
  const request = calls.find((call) => new URL(call.url).pathname.endsWith('/signup'))!;
  expect(new URL(request.url).searchParams.get('redirect_to')).toBe(`${origin}/auth-confirm.html`);
  expect(request.body).toMatchObject({ code_challenge_method: 's256' });
  await page.goto(`${origin}/auth-confirm.html?code=synthetic-code`);
  await expect(page).toHaveURL(`${origin}/auth-confirm.html`);
  await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
  expect(calls.filter((call) => call.body?.auth_code)).toHaveLength(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email confirmed', exact: true })).toBeVisible();
  expect(
    calls.some(
      (call) =>
        call.body?.auth_code === 'synthetic-code' && typeof call.body.code_verifier === 'string',
    ),
  ).toBe(true);
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
});

test('invalid, injected, implicit and expired links never confirm', async ({ page }) => {
  const calls = await provider(page, {
    token: { status: 400, body: { code: 'flow_state_expired' } },
  });
  for (const suffix of [
    '',
    '?code=a&code=b',
    '?code=a&next=https://evil.test',
    '#access_token=synthetic',
  ]) {
    await page.goto(`${origin}/auth-confirm.html${suffix}`);
    await expect(
      page.getByRole('heading', { name: 'This confirmation link cannot be used' }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${origin}/auth-confirm.html`);
  }
  expect(calls).toHaveLength(0);
  await signup(page);
  await page.goto(`${origin}/auth-confirm.html?code=expired-code`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'This confirmation link cannot be used' }),
  ).toBeVisible();
});

async function recoveryEmail(page: Page, appOrigin = origin) {
  await signInScreen(page, appOrigin);
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await page.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

test('recovery opens in a new tab, changes password once, then requires sign in', async ({
  page,
  context,
}) => {
  const calls = await provider(page);
  await recoveryEmail(page);
  expect(new URL(calls[0]!.url).searchParams.get('redirect_to')).toBe(`${origin}/auth-reset.html`);
  const reset = await context.newPage();
  const resetCalls = await provider(reset);
  await reset.goto(`${origin}/auth-reset.html?code=recovery-code`);
  await expect(reset).toHaveURL(`${origin}/auth-reset.html`);
  await reset.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(reset.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await reset.getByLabel('New password', { exact: true }).fill('new-synthetic-password');
  await reset.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(reset.getByRole('heading', { name: 'Password updated' })).toBeVisible();
  expect(
    resetCalls.filter((call) => call.body?.password === 'new-synthetic-password'),
  ).toHaveLength(1);
  await reset.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(reset.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await reset.getByLabel('Password', { exact: true }).fill('new-synthetic-password');
  await reset.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(reset.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
  await reset.getByRole('button', { name: 'Sign out', exact: true }).click();
  await reset.goto(`${origin}/owner-auth.html`);
  await expect(reset.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
});

test('another tab replacing the session cancels recovery permission', async ({ page, context }) => {
  const calls = await provider(page);
  await recoveryEmail(page);
  await page.goto(`${origin}/auth-reset.html?code=recovery-code`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  const other = await context.newPage();
  await provider(other);
  await other.goto(`${origin}/owner-auth.html`);
  await expect(other.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await other.getByLabel('Email address').fill(email);
  await other.getByRole('button', { name: 'Continue', exact: true }).click();
  await other.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await other.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('must-not-be-sent');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This reset link can’t be used' })).toBeVisible();
  expect(calls.some((call) => call.body?.password === 'must-not-be-sent')).toBe(false);
});

test('direct and signup-purpose reset links cannot authorize a password update', async ({
  page,
}) => {
  const calls = await provider(page);
  await page.goto(`${origin}/auth-reset.html`);
  await expect(page.getByRole('heading', { name: 'This reset link can’t be used' })).toBeVisible();
  expect(calls).toHaveLength(0);
  await signup(page);
  await page.goto(`${origin}/auth-reset.html?code=signup-code`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This reset link can’t be used' })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  expect(
    calls.filter((call) => new URL(call.url).pathname.endsWith('/user') && call.body?.password),
  ).toHaveLength(0);
  await page.goto(`${origin}/owner-auth.html`);
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
});

test('weak and unchanged passwords show actionable provider outcomes', async ({ page }) => {
  await provider(page, {
    'user:PUT': { status: 422, body: { code: 'weak_password', message: 'private detail' } },
  });
  await recoveryEmail(page);
  await page.goto(`${origin}/auth-reset.html?code=recovery-code`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('New password', { exact: true }).fill('weak');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose a stronger password');
  await expect(page.getByRole('alert')).not.toContainText('private detail');
  await page.unroute('https://auth-fixture.supabase.co/auth/v1/**');
  await provider(page, {
    'user:PUT': { status: 422, body: { code: 'same_password', message: 'private detail' } },
  });
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose a different password');
});

test('a concurrent account switch cannot redirect an in-flight reset to another owner', async ({
  page,
  context,
}) => {
  const calls = await provider(page);
  await recoveryEmail(page);
  await page.goto(`${origin}/auth-reset.html?code=recovery-code`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://auth-fixture.supabase.co/auth/v1/user', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    entered();
    await resume;
    await route.fulfill({ json: user }).catch(() => {}); // The session guard can cancel this request first.
  });
  await page.getByLabel('New password', { exact: true }).fill('must-not-switch-owner');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await checking;
  const other = await context.newPage();
  const ownerB = {
    ...user,
    id: '00000000-0000-4000-8000-000000000002',
    email: 'other@example.test',
  };
  const otherCalls = await provider(other, {
    token: { body: { ...session, user: ownerB, access_token: 'synthetic-owner-b' } },
    user: { body: ownerB },
  });
  await other.goto(`${origin}/owner-auth.html`);
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await other.getByLabel('Email address').fill(ownerB.email);
  await other.getByRole('button', { name: 'Continue', exact: true }).click();
  await other.getByLabel('Password', { exact: true }).fill('other-synthetic-password');
  await other.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'This reset link can’t be used' })).toBeVisible();
  expect(
    [...calls, ...otherCalls].some((call) => call.body?.password === 'must-not-switch-owner'),
  ).toBe(false);
});

test('signup Resend uses the live SDK, respects the wait and confirms its new PKCE link', async ({
  page,
}) => {
  await page.clock.install();
  const calls = await provider(page);
  await signup(page);
  const resend = page.getByRole('button', { name: 'Resend email', exact: true });
  await expect(resend).toBeVisible();
  await expect(resend).toHaveAttribute('aria-disabled', 'true');
  await resend.dispatchEvent('click');
  expect(calls.filter((call) => new URL(call.url).pathname.endsWith('/resend'))).toHaveLength(0);
  await page.clock.runFor(61_000);
  await resend.click();
  await expect(page.getByText('We’ve sent another link.', { exact: true })).toBeVisible();
  await expect(resend).toHaveAttribute('aria-disabled', 'true');
  const requests = calls.filter((call) => new URL(call.url).pathname.endsWith('/resend'));
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).searchParams.get('redirect_to')).toBe(
    `${origin}/auth-confirm.html`,
  );
  expect(requests[0]!.body).toMatchObject({ email, type: 'signup', code_challenge_method: 's256' });
  await page.goto(`${origin}/auth-confirm.html?code=resent-signup-code`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email confirmed', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${origin}/auth-confirm.html`);
});

test('signup Resend maps provider throttling without exposing provider details', async ({
  page,
}) => {
  await page.clock.install();
  const calls = await provider(page, {
    resend: {
      status: 429,
      body: { code: 'over_email_send_rate_limit', msg: 'private fixture detail' },
    },
  });
  await signup(page);
  await page.clock.runFor(61_000);
  await page.getByRole('button', { name: 'Resend email', exact: true }).click();
  await expect(page.locator('.pp-auth-resend__status')).toContainText('Too many attempts');
  await expect(page.getByText('private fixture detail')).toHaveCount(0);
  expect(calls.filter((call) => new URL(call.url).pathname.endsWith('/resend'))).toHaveLength(1);
});

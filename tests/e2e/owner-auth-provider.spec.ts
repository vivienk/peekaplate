import { expect, type Page, test } from '@playwright/test';

const origin = 'http://127.0.0.1:5174';
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
  access_token: 'synthetic-access-token',
  refresh_token: 'synthetic-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  user,
};

async function provider(
  page: Page,
  overrides: Record<string, { status?: number; body: unknown }> = {},
) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  await page.route('https://auth-fixture.supabase.co/auth/v1/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*' },
      });
      return;
    }
    const path = new URL(request.url()).pathname.split('/').at(-1)!;
    calls.push({
      url: request.url(),
      body: request.postDataJSON() as Record<string, unknown> | null,
    });
    const answer = overrides[path] ?? {
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
        'Access-Control-Allow-Origin': origin,
        'X-Supabase-Api-Version': '2024-01-01',
        'Access-Control-Expose-Headers': 'X-Supabase-Api-Version',
      },
    });
  });
  return calls;
}

async function signInScreen(page: Page) {
  await page.goto(`${origin}/owner-auth.html`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}

async function signup(page: Page) {
  await signInScreen(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Full name').fill('Synthetic Owner');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('checkbox', { name: /I agree/ }).check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

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

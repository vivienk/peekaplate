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
  access_token: `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.c3ludGhldGlj`,
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
    const answer = overrides[`${path}:${request.method()}`] ??
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

async function recoveryEmail(page: Page) {
  await signInScreen(page);
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

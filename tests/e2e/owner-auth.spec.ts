import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// S4-FE-04.1: E1 Enter email, S01 Create account and S02 Sign in on the preview-only demo page. A
// synthetic service answers with the outcome picked in the demo bar; the screens run unchanged.
const demo = 'http://127.0.0.1:5174/owner-sign-in.html';
const EMAIL = 'owner@restaurant.com';

const answer = (page: Page, service: string, value: string) =>
  page.getByLabel(`${service} answer`, { exact: true }).selectOption(value);

async function continueWith(page: Page, email = EMAIL) {
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function openSignIn(page: Page) {
  await page.goto(demo);
  await continueWith(page);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
}

async function openCreate(page: Page) {
  await page.goto(demo);
  await answer(page, 'Email check', 'new_account');
  await continueWith(page);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeFocused();
}

const passwordField = (page: Page) => page.getByLabel('Password', { exact: true });
const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in', exact: true });

test('the demo is labelled synthetic and opens on Enter email without moving focus', async ({
  page,
}) => {
  await page.goto(demo);
  await expect(page.getByText('Synthetic demo.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to PeekaPlate');
  await expect(page.getByRole('heading', { level: 1 })).not.toBeFocused();
});

test('Enter email checks the address in the browser before sending anything', async ({ page }) => {
  await page.goto(demo);
  const email = page.getByLabel('Email address');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAccessibleDescription('Error: Enter your email address');

  await email.fill('owner@restaurant');
  await email.press('Enter');
  await expect(email).toHaveAccessibleDescription('Error: Enter a valid email address');
  await expect(email).toHaveValue('owner@restaurant');

  // Editing clears the error and returns the field to its default state.
  await email.pressSequentially('.com');
  await expect(email).not.toHaveAttribute('aria-invalid');
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
});

test('an existing account goes to Sign in, and Change returns with the email kept', async ({
  page,
}) => {
  await page.goto(demo);
  await continueWith(page);
  await expect(page.getByRole('button', { name: 'Checking…' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(page.getByLabel('Email address')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(EMAIL);
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('readonly', '');

  await page.getByRole('button', { name: 'Change email address' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeFocused();
  await expect(page.getByLabel('Email address')).toHaveValue(EMAIL);
});

test('a new email goes to Create account, which links to Sign in', async ({ page }) => {
  await openCreate(page);
  await expect(page.getByRole('textbox', { name: 'Email address' })).toHaveValue(EMAIL);
  await expect(page.getByRole('textbox', { name: 'Email address' })).toHaveAttribute(
    'readonly',
    '',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeFocused();
});

test('Create account checks every field and focuses the first problem', async ({ page }) => {
  await openCreate(page);
  const create = page.getByRole('button', { name: 'Create account', exact: true });
  await create.click();

  const name = page.getByLabel('Full name');
  const terms = page.getByRole('checkbox', { name: /I agree to the Terms of Service/ });
  await expect(name).toBeFocused();
  await expect(name).toHaveAccessibleDescription('Error: Enter your full name');
  await expect(passwordField(page)).toHaveAccessibleDescription('Error: Create a password');
  await expect(terms).toHaveAccessibleDescription(
    'Error: Agree to the terms to create your account',
  );

  await name.fill('Sam Rivera');
  await passwordField(page).fill('short');
  await create.click();
  await expect(passwordField(page)).toBeFocused();
  await expect(passwordField(page)).toHaveAccessibleDescription('Error: Use at least 8 characters');

  await passwordField(page).fill('long-enough');
  await expect(passwordField(page)).toHaveAccessibleDescription('Use at least 8 characters');
  await create.click();
  await expect(terms).toBeFocused();

  await terms.check();
  await answer(page, 'Create account', 'created');
  await create.click();
  await expect(page.getByRole('button', { name: 'Creating account…' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account created (demo)' })).toBeVisible();
  await expect(page.getByText('Demo only: nobody is signed in.')).toBeVisible();
});

async function fillCreate(page: Page) {
  await page.getByLabel('Full name').fill('Sam Rivera');
  await passwordField(page).fill('long-enough');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
}

test('when confirmation is required, Create account shows Check your email', async ({ page }) => {
  await openCreate(page);
  await fillCreate(page);
  const heading = page.getByRole('heading', { name: 'Check your email' });
  await expect(heading).toBeFocused();
  await expect(
    page.getByText(
      `If this address can be registered, a confirmation link will arrive at ${EMAIL}`,
    ),
  ).toBeVisible();
  // The result screen has no logo (Figma "Check your email").
  await expect(page.locator('.pp-auth__brand')).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit email address' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeFocused();
  await expect(page.getByLabel('Email address')).toHaveValue(EMAIL);
});

test('Check your email links back to Sign in', async ({ page }) => {
  await openCreate(page);
  await fillCreate(page);
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(EMAIL);
});

test('signing in before confirming the email asks to confirm it first', async ({ page }) => {
  await openSignIn(page);
  await answer(page, 'Sign in', 'email_not_confirmed');
  await passwordField(page).fill('right-password');
  await signInButton(page).click();
  await expect(page.getByRole('alert')).toContainText('Confirm your email first');
  await expect(passwordField(page)).toHaveValue('right-password');
});

test('too many attempts blocks the button for the wait the service gives', async ({ page }) => {
  await openSignIn(page);
  await answer(page, 'Sign in', 'rate_limited');
  await passwordField(page).fill('some-password');
  await signInButton(page).click();
  await expect(page.getByRole('alert')).toHaveText(
    /Too many attempts\s*Please wait 5 seconds and try again\./,
  );
  await expect(page.getByText('Requests sent: 2')).toBeVisible();
  await expect(signInButton(page)).toHaveAttribute('aria-disabled', 'true');

  // Submitting while blocked sends nothing. (Playwright's click() waits for aria-disabled to clear,
  // so the form is submitted from the keyboard.)
  await passwordField(page).press('Enter');
  await signInButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(signInButton(page)).toBeFocused();
  await expect(page.getByText('Requests sent: 2')).toBeVisible();

  // After the wait the button works again.
  await expect(signInButton(page)).not.toHaveAttribute('aria-disabled', { timeout: 8_000 });
  await answer(page, 'Sign in', 'invalid_credentials');
  await signInButton(page).click();
  await expect(page.getByText('Requests sent: 3')).toBeVisible();
});

test('too many attempts on Enter email and Create account', async ({ page }) => {
  await page.goto(demo);
  await answer(page, 'Email check', 'rate_limited');
  await continueWith(page);
  await expect(page.getByRole('alert')).toContainText('Too many attempts');
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  await openCreate(page);
  await answer(page, 'Create account', 'rate_limited');
  await fillCreate(page);
  await expect(page.getByRole('alert')).toContainText('Please wait 5 seconds');
});

test('an existing account on Create account offers Sign in instead', async ({ page }) => {
  await openCreate(page);
  await answer(page, 'Create account', 'account_exists');
  await page.getByLabel('Full name').fill('Sam Rivera');
  await passwordField(page).fill('long-enough');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('An account already exists for this email');
  await page.getByRole('button', { name: 'Sign in instead' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
});

test('Sign in: empty password, then wrong details clear only the password', async ({ page }) => {
  await openSignIn(page);
  await signInButton(page).click();
  await expect(passwordField(page)).toBeFocused();
  await expect(passwordField(page)).toHaveAccessibleDescription('Error: Enter your password');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await passwordField(page).fill('wrong-password');
  await passwordField(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Signing in…' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(passwordField(page)).toHaveAttribute('readonly', '');

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(/Email or password is incorrect\s*Check your details/);
  await expect(passwordField(page)).toHaveValue('');
  await expect(passwordField(page)).toBeFocused();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(EMAIL);

  // The banner goes when the next request starts.
  await passwordField(page).fill('another-try');
  await signInButton(page).click();
  await expect(alert).toHaveCount(0);
  await expect(alert).toBeVisible();
});

test('a service failure keeps the details, and a correct retry signs in', async ({ page }) => {
  await openSignIn(page);
  await answer(page, 'Sign in', 'failed');
  await passwordField(page).fill('right-password');
  await signInButton(page).click();
  await expect(page.getByRole('alert')).toContainText('We couldn’t sign you in');
  await expect(passwordField(page)).toHaveValue('right-password');

  await answer(page, 'Sign in', 'signed_in');
  await signInButton(page).click();
  await expect(page.getByRole('heading', { name: 'Sign-in accepted (demo)' })).toBeVisible();
  await expect(page.getByText('Demo only: nobody is signed in.')).toBeVisible();
});

test('a double press sends one request', async ({ page }) => {
  await openSignIn(page);
  await expect(page.getByText('Requests sent: 1')).toBeVisible();
  await passwordField(page).fill('wrong-password');
  await signInButton(page).dblclick();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Requests sent: 2')).toBeVisible();
});

test('show and hide password keeps the typed value', async ({ page }) => {
  await openSignIn(page);
  await passwordField(page).fill('secret-value');
  await expect(passwordField(page)).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(passwordField(page)).toHaveAttribute('type', 'text');
  await expect(passwordField(page)).toHaveValue('secret-value');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(passwordField(page)).toHaveAttribute('type', 'password');
});

test('when sign-in is not connected the screens say so and sign nobody in', async ({ page }) => {
  await page.goto(demo);
  await answer(page, 'Email check', 'unavailable');
  await continueWith(page);
  await expect(page.getByRole('alert')).toContainText('Sign-in isn’t available yet');
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
});

test('the whole flow works from the keyboard', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Email address').focus();
  await page.keyboard.type(EMAIL);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
  // The read-only email stays in the tab order so it can be read and copied.
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Change email address' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(passwordField(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(signInButton(page)).toBeFocused();
});

test('every screen and error state passes the accessibility scan', async ({ page }) => {
  const scan = async () => {
    const { violations } = await new AxeBuilder({ page })
      .include('.pp-auth')
      // The orange wordmark is the logo; logotypes have no contrast requirement (WCAG 1.4.3).
      .exclude('.pp-auth__brand')
      .analyze();
    expect(violations).toEqual([]);
  };
  await page.goto(demo);
  await page.getByRole('button', { name: 'Continue' }).click();
  await scan();
  await continueWith(page);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
  await passwordField(page).fill('wrong-password');
  await signInButton(page).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await scan();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await scan();
  await page.getByLabel('Full name').fill('Sam Rivera');
  await passwordField(page).fill('long-enough');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await scan();
});

test('on a phone the card fills the width without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openCreate(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const card = await page.locator('.pp-auth__card').boundingBox();
  expect(card?.x).toBe(16);
});

test('on a wide screen the card sits on the right, leaving the left side for the photo', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(demo);
  const card = await page.locator('.pp-auth__card').boundingBox();
  expect(card?.x).toBeGreaterThanOrEqual(720);
  expect(Math.round((card?.x ?? 0) + (card?.width ?? 0))).toBe(1440 - 96);
  await expect(page.locator('.pp-auth__art')).toHaveAttribute('aria-hidden', 'true');
});

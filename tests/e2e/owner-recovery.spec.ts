import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// S4-FE-04: password recovery, S03 Forgot password and S04 Reset password, on the preview-only
// demo page. The synthetic service answers with the outcome picked in the demo bar.
const demo = 'http://127.0.0.1:5174/owner-sign-in.html';
const EMAIL = 'owner@restaurant.com';

const answer = (page: Page, service: string, value: string) =>
  page.getByLabel(`${service} answer`, { exact: true }).selectOption(value);
const heading = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });
const sendLink = (page: Page) => page.getByRole('button', { name: 'Send reset link' });

async function openForgot(page: Page) {
  await page.goto(demo);
  await page.getByLabel('Email address').fill(EMAIL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(heading(page, 'Welcome back')).toBeFocused();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(heading(page, 'Forgot password?')).toBeFocused();
}

async function openReset(page: Page) {
  await page.goto(demo);
  await page.getByRole('button', { name: 'Open reset link from email' }).click();
  await expect(heading(page, 'Reset your password')).toBeVisible();
}

const newPassword = (page: Page) => page.getByLabel('New password');

test('Forgot password opens from Sign in with the email filled in', async ({ page }) => {
  await openForgot(page);
  await expect(page.getByLabel('Email address')).toHaveValue(EMAIL);
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(heading(page, 'Welcome back')).toBeFocused();
});

test('S03 checks the email before sending (Validation error)', async ({ page }) => {
  await openForgot(page);
  const email = page.getByLabel('Email address');
  await email.fill('');
  await sendLink(page).click();
  await expect(email).toBeFocused();
  await expect(email).toHaveAccessibleDescription('Error: Enter your email address');
  await email.fill('owner@restaurant');
  await email.press('Enter');
  await expect(email).toHaveAccessibleDescription('Error: Enter a valid email address');
  await expect(page.getByText('Requests sent: 1')).toBeVisible();
});

test('S03 Request failed keeps the email and offers Try again', async ({ page }) => {
  await openForgot(page);
  await answer(page, 'Reset link', 'failed');
  await sendLink(page).click();
  await expect(page.getByRole('alert')).toHaveText(
    /We couldn’t send the reset link\s*Please try again\./,
  );
  await expect(page.getByLabel('Email address')).toHaveValue(EMAIL);
  await answer(page, 'Reset link', 'sent');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(heading(page, 'Check your email')).toBeFocused();
});

test('S03 Check email never confirms the account, and Resend waits before it can be used', async ({
  page,
}) => {
  await openForgot(page);
  await sendLink(page).click();
  await expect(heading(page, 'Check your email')).toBeFocused();
  await expect(
    page.getByText(`If an account exists for ${EMAIL}, we’ll send a link`),
  ).toBeVisible();
  await expect(page.locator('.pp-auth__brand')).toHaveCount(0);

  const resend = page.getByRole('button', { name: 'Resend email' });
  await expect(resend).toHaveAttribute('aria-disabled', 'true');
  await expect(resend).toHaveAccessibleDescription(
    'Resend is unavailable right now. Please wait before requesting another link.',
  );
  await expect(page.getByText('Requests sent: 2')).toBeVisible();

  // The service's wait (5 s in the demo) passes, then Resend sends another link.
  await expect(resend).not.toHaveAttribute('aria-disabled', { timeout: 8_000 });
  await resend.click();
  await expect(page.getByText('We’ve sent another link.')).toBeVisible();
  await expect(page.getByText('Requests sent: 3')).toBeVisible();
  await expect(resend).toHaveAttribute('aria-disabled', 'true');
});

test('S03 Check email: Edit email address and Back to sign in', async ({ page }) => {
  await openForgot(page);
  await sendLink(page).click();
  await page.getByRole('button', { name: 'Edit email address' }).click();
  await expect(heading(page, 'Forgot password?')).toBeFocused();
  await expect(page.getByLabel('Email address')).toHaveValue(EMAIL);
  await sendLink(page).click();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(heading(page, 'Welcome back')).toBeFocused();
});

test('S04 asks for a new password, with show/hide and the hint', async ({ page }) => {
  await openReset(page);
  await expect(newPassword(page)).toHaveAttribute('autocomplete', 'new-password');
  await expect(newPassword(page)).toHaveAccessibleDescription(
    'Choose a password that’s hard to guess.',
  );
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(newPassword(page)).toBeFocused();
  await expect(newPassword(page)).toHaveAccessibleDescription('Error: Enter a new password');

  await newPassword(page).fill('a-new-password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(newPassword(page)).toHaveAttribute('type', 'text');
  await expect(newPassword(page)).toHaveValue('a-new-password');
});

test('S04 Request failed keeps the password, then Password updated returns to sign in', async ({
  page,
}) => {
  await openReset(page);
  await answer(page, 'Reset password', 'failed');
  await newPassword(page).fill('a-new-password');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    /We couldn’t reset your password\s*Please try again\./,
  );
  await expect(newPassword(page)).toHaveValue('a-new-password');

  await answer(page, 'Reset password', 'updated');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(heading(page, 'Password updated')).toBeFocused();
  await expect(page.getByText('Your password has been changed.')).toBeVisible();
  // The demo service does not return the email, so Sign in starts at Enter email.
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(heading(page, 'Welcome to PeekaPlate')).toBeFocused();
});

test('S04 an invalid link on submit, or an expired link on open, offers a new link', async ({
  page,
}) => {
  await openReset(page);
  await answer(page, 'Reset password', 'invalid_link');
  await newPassword(page).fill('a-new-password');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(heading(page, 'This reset link can’t be used')).toBeFocused();
  await page.getByRole('button', { name: 'Request a new link' }).click();
  await expect(heading(page, 'Forgot password?')).toBeFocused();

  await page.getByRole('button', { name: 'Open expired reset link' }).click();
  await expect(heading(page, 'This reset link can’t be used')).toBeVisible();
  await expect(page.locator('.pp-auth__brand')).toHaveCount(0);
});

test('S03 and S04 screens pass the accessibility scan', async ({ page }) => {
  const scan = async () => {
    const { violations } = await new AxeBuilder({ page })
      .include('.pp-auth')
      .exclude('.pp-auth__brand')
      .analyze();
    expect(violations).toEqual([]);
  };
  await openForgot(page);
  await answer(page, 'Reset link', 'failed');
  await sendLink(page).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await scan();
  await answer(page, 'Reset link', 'sent');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(heading(page, 'Check your email')).toBeVisible();
  await scan();
  await page.getByRole('button', { name: 'Open reset link from email' }).click();
  await page.getByRole('button', { name: 'Reset password' }).click();
  await scan();
  await newPassword(page).fill('a-new-password');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(heading(page, 'Password updated')).toBeVisible();
  await scan();
  await page.getByRole('button', { name: 'Open expired reset link' }).click();
  await scan();
});

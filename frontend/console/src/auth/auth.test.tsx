import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { notConnectedAuthService } from './auth-service';
import {
  BANNERS,
  emailError,
  fullNameError,
  newPasswordError,
  rateLimitedBanner,
  signInPasswordError,
  waitText,
} from './copy';
import { OwnerAuth } from './OwnerAuth';

describe('owner sign-in field checks (S4-FE-04.1)', () => {
  it('asks for an email, then a valid one (S02 handoff, section 1)', () => {
    expect(emailError('')).toBe('Enter your email address');
    expect(emailError('   ')).toBe('Enter your email address');
    for (const bad of ['owner', 'owner@', '@restaurant.com', 'owner@restaurant', 'a b@c.com']) {
      expect(emailError(bad)).toBe('Enter a valid email address');
    }
    expect(emailError(`${'a'.repeat(250)}@b.co`)).toBe('Enter a valid email address');
    expect(emailError(' owner@restaurant.com ')).toBeUndefined();
  });

  it('sign in needs any password; a new password needs at least 8 characters', () => {
    expect(signInPasswordError('')).toBe('Enter your password');
    expect(signInPasswordError('x')).toBeUndefined();
    expect(newPasswordError('')).toBe('Create a password');
    expect(newPasswordError('1234567')).toBe('Use at least 8 characters');
    expect(newPasswordError('12345678')).toBeUndefined();
    // Characters, not UTF-16 units: four emoji are four characters.
    expect(newPasswordError('🍅🍅🍅🍅')).toBe('Use at least 8 characters');
  });

  it('asks for a full name that is not just spaces', () => {
    expect(fullNameError('  ')).toBe('Enter your full name');
    expect(fullNameError('Sam Rivera')).toBeUndefined();
  });

  it('never says which detail was wrong or whether an account exists after a failed sign-in', () => {
    const text = `${BANNERS.invalidCredentials.title} ${BANNERS.invalidCredentials.body}`;
    expect(text).toBe('Email or password is incorrect Check your details and try again.');
  });
});

describe('too many attempts', () => {
  it('says how long to wait when the service gives a wait', () => {
    expect(waitText(1)).toBe('1 second');
    expect(waitText(4.2)).toBe('5 seconds');
    expect(waitText(60)).toBe('1 minute');
    expect(waitText(61)).toBe('2 minutes');
    expect(rateLimitedBanner(30).body).toBe('Please wait 30 seconds and try again.');
  });

  it('says to try again later without a wait', () => {
    expect(rateLimitedBanner().body).toBe('Please try again later.');
    expect(rateLimitedBanner(0).body).toBe('Please try again later.');
  });
});

describe('until the auth provider is connected', () => {
  it('answers every call as unavailable, never as a sign-in', async () => {
    expect(await notConnectedAuthService.checkEmail('owner@restaurant.com')).toEqual({
      kind: 'unavailable',
    });
    expect(
      await notConnectedAuthService.signIn({ email: 'owner@restaurant.com', password: 'x' }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await notConnectedAuthService.createAccount({
        fullName: 'Sam',
        email: 'owner@restaurant.com',
        password: '12345678',
        acceptedTerms: true,
      }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('OwnerAuth screens', () => {
  const html = (props: Partial<Parameters<typeof OwnerAuth>[0]> = {}) =>
    renderToStaticMarkup(
      <OwnerAuth
        service={notConnectedAuthService}
        onSignedIn={() => {}}
        onAccountCreated={() => {}}
        {...props}
      />,
    );

  it('opens on Enter email with a labelled email field', () => {
    const page = html();
    expect(page).toContain('Welcome to PeekaPlate');
    expect(page).toContain('autoComplete="email"');
    expect(page).not.toContain('type="password"');
  });

  it('pairs the locked email with the password for password managers', () => {
    const page = html({ initialStep: 'signin', initialEmail: 'owner@restaurant.com' });
    expect(page).toContain('autoComplete="username"');
    expect(page).toContain('autoComplete="current-password"');
    expect(page).toContain('aria-label="Show password"');
  });

  it('hides "Forgot password?" until recovery exists', () => {
    const signIn = { initialStep: 'signin' as const, initialEmail: 'owner@restaurant.com' };
    expect(html(signIn)).not.toContain('Forgot password?');
    expect(html({ ...signIn, onForgotPassword: () => {} })).toContain('Forgot password?');
  });

  it('create account asks for a new password with the 8-character hint', () => {
    const page = html({ initialStep: 'create', initialEmail: 'owner@restaurant.com' });
    expect(page).toContain('autoComplete="new-password"');
    expect(page).toContain('Use at least 8 characters');
    expect(page).toContain('type="checkbox"');
  });
});

// S4-FE-04.1: field checks and wording for the owner sign-in screens. The checks run in the
// browser on submit; a failed check sends no request. Wording marked PROPOSED in the S02 handoff
// (validation and banner copy) is used as written there; wording the handoff does not cover is
// listed in the PR for design to confirm.

// One "@", something on each side and a dot in the domain. The provider makes the final decision.
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
export const MIN_PASSWORD_LENGTH = 8;

export function emailError(value: string): string | undefined {
  const email = value.trim();
  if (!email) return 'Enter your email address';
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_FORMAT.test(email)) {
    return 'Enter a valid email address';
  }
  return undefined;
}

// Sign in checks only that a password was entered; its rules belong to account creation.
export function signInPasswordError(value: string): string | undefined {
  return value ? undefined : 'Enter your password';
}

export function newPasswordError(value: string): string | undefined {
  if (!value) return 'Create a password';
  if ([...value].length < MIN_PASSWORD_LENGTH) return 'Use at least 8 characters';
  return undefined;
}

export function fullNameError(value: string): string | undefined {
  return value.trim() ? undefined : 'Enter your full name';
}

export const TERMS_ERROR = 'Agree to the terms to create your account';

export type BannerCopy = { title: string; body: string };

const TRY_AGAIN = 'Something went wrong on our side. Check your connection and try again.';

export const BANNERS = {
  weakPassword: {
    title: 'Choose a stronger password',
    body: 'Use a longer, unique password and try again.',
  },
  // S02 handoff, section 2.
  invalidCredentials: {
    title: 'Email or password is incorrect',
    body: 'Check your details and try again.',
  },
  // S02 handoff, section 3.
  signInFailed: { title: 'We couldn’t sign you in', body: TRY_AGAIN },
  continueFailed: { title: 'We couldn’t continue', body: TRY_AGAIN },
  createFailed: { title: 'We couldn’t create your account', body: TRY_AGAIN },
  accountExists: {
    title: 'An account already exists for this email',
    body: 'Sign in instead, or change the email address.',
  },
  // Sign in with an email address that is not confirmed yet.
  emailNotConfirmed: {
    title: 'Confirm your email first',
    body: 'Open the confirmation link we sent to this email address, then sign in.',
  },
  // Owner accounts are not connected in this build: nothing was sent and nobody is signed in.
  unavailable: {
    title: 'Sign-in isn’t available yet',
    body: 'Owner accounts aren’t connected here yet, so nothing was sent.',
  },
} satisfies Record<string, BannerCopy>;

// How long to wait, in words: "30 seconds", "1 minute", "5 minutes".
export function waitText(seconds: number): string {
  if (seconds < 60) {
    const whole = Math.max(1, Math.ceil(seconds));
    return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

// Too many attempts. With a wait from the service the owner is told how long; without one, later.
export function rateLimitedBanner(retryAfterSeconds?: number): BannerCopy {
  return {
    title: 'Too many attempts',
    body:
      retryAfterSeconds && retryAfterSeconds > 0
        ? `Please wait ${waitText(retryAfterSeconds)} and try again.`
        : 'Please try again later.',
  };
}

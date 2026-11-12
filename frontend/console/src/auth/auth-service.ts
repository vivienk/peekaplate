// Screens use typed outcomes; supabase-auth.ts owns provider calls. Synthetic demos keep their
// fake service. Missing live configuration returns unavailable without sending credentials.

// Too many attempts: the provider or server is throttling requests. retryAfterSeconds is the wait
// the service supplied, if any; the screens keep the action blocked until it has passed. There is no
// attempt-based lockout in the frontend (Sai, 11 Nov).
export type RateLimited = { kind: 'rate_limited'; retryAfterSeconds?: number };

export type EmailCheckResult =
  // Live flow never discloses account existence. Sign in always offers Create account.
  | { kind: 'continue_to_sign_in' }
  // An owner account exists for this email: go to Sign in (S02).
  | { kind: 'existing_account' }
  // No account yet: go to Create account (S01).
  | { kind: 'new_account' }
  // Network, timeout, server or provider failure. The owner can try again.
  | { kind: 'failed' }
  // Owner accounts are not connected in this build.
  | { kind: 'unavailable' }
  | RateLimited;

export type SignInResult =
  | { kind: 'signed_in' }
  // Email and password do not match an account, including an unknown email. The screen never says
  // which one was wrong or whether an account exists (S02 handoff, section 2).
  | { kind: 'invalid_credentials' }
  // The details are right but the email address is not confirmed yet. Confirmation is required
  // before any authenticated access (Sai, 11 Nov).
  | { kind: 'email_not_confirmed' }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | RateLimited;

export type CreateAccountResult =
  // Created and usable straight away.
  | { kind: 'created' }
  // Created, and a confirmation email was sent: the screen shows "Check your email". Confirming
  // returns the owner to the app.
  | { kind: 'confirmation_required' }
  | { kind: 'weak_password' }
  // An account already exists for this email: the screen offers Sign in instead.
  | { kind: 'account_exists' }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | RateLimited;

// S03: request a password reset link. "sent" must be the answer whether or not an account exists
// for the address, so the screen never reveals which emails are registered (S03 handoff, section 4).
// resendAfterSeconds is how long "Resend email" stays unavailable, if the service says.
export type ResetLinkResult =
  | { kind: 'sent'; resendAfterSeconds?: number }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | RateLimited;

// S04: set a new password from the reset link. email, when known, lets "Sign in" open S02 directly.
export type ResetPasswordResult =
  | { kind: 'updated'; email?: string; signOutPending?: true }
  | { kind: 'weak_password' }
  | { kind: 'same_password' }
  // The link is invalid, expired or already used (S04 handoff, section 2).
  | { kind: 'invalid_link' }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | RateLimited;

export type SignInRequest = { email: string; password: string };

export type CreateAccountRequest = {
  fullName: string;
  email: string;
  password: string;
  // The owner ticked "I agree to the Terms of Service and Privacy Policy, and confirm I'm
  // authorized to manage this restaurant". The screen never sends a request without it.
  acceptedTerms: true;
};

export interface OwnerAuthService {
  checkEmail(email: string): Promise<EmailCheckResult>;
  signIn(request: SignInRequest): Promise<SignInResult>;
  createAccount(request: CreateAccountRequest): Promise<CreateAccountResult>;
  requestPasswordReset(email: string): Promise<ResetLinkResult>;
  // Uses the recovery session from the reset link; the link itself never reaches the screens.
  resetPassword(newPassword: string): Promise<ResetPasswordResult>;
}

// The service used until the provider is connected. It sends nothing anywhere.
export const notConnectedAuthService: OwnerAuthService = {
  checkEmail: async () => ({ kind: 'unavailable' }),
  signIn: async () => ({ kind: 'unavailable' }),
  createAccount: async () => ({ kind: 'unavailable' }),
  requestPasswordReset: async () => ({ kind: 'unavailable' }),
  resetPassword: async () => ({ kind: 'unavailable' }),
};

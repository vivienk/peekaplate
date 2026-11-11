// S4-FE-04.1: the only place the owner sign-in screens reach the auth provider. The screens react
// to these results and nothing else, so connecting a real provider (Sai, S4-FE-04 backend) changes
// this file only. Until then every call answers "unavailable" and the screens say sign-in is not
// available here; they never show a sign-in as successful without a real one.

// Too many attempts: the provider or server is throttling requests. retryAfterSeconds is the wait
// the service supplied, if any; the screens keep the action blocked until it has passed. There is no
// attempt-based lockout in the frontend (Sai, 11 Nov).
export type RateLimited = { kind: 'rate_limited'; retryAfterSeconds?: number };

export type EmailCheckResult =
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
  // An account already exists for this email: the screen offers Sign in instead.
  | { kind: 'account_exists' }
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
}

// The service used until the provider is connected. It sends nothing anywhere.
export const notConnectedAuthService: OwnerAuthService = {
  checkEmail: async () => ({ kind: 'unavailable' }),
  signIn: async () => ({ kind: 'unavailable' }),
  createAccount: async () => ({ kind: 'unavailable' }),
};

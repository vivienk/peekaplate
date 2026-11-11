// S4-FE-04.1: the only place the owner sign-in screens reach the auth provider. The screens react
// to these results and nothing else, so connecting a real provider (Sai, S4-FE-04 backend) changes
// this file only. Until then every call answers "unavailable" and the screens say sign-in is not
// available here; they never show a sign-in as successful without a real one.

export type EmailCheckResult =
  // An owner account exists for this email: go to Sign in (S02).
  | { kind: 'existing_account' }
  // No account yet: go to Create account (S01).
  | { kind: 'new_account' }
  // Network, timeout, server or provider failure. The owner can try again.
  | { kind: 'failed' }
  // Owner accounts are not connected in this build.
  | { kind: 'unavailable' };

export type SignInResult =
  | { kind: 'signed_in' }
  // Email and password do not match an account, including an unknown email. The screen never says
  // which one was wrong or whether an account exists (S02 handoff, section 2).
  | { kind: 'invalid_credentials' }
  | { kind: 'failed' }
  | { kind: 'unavailable' };

export type CreateAccountResult =
  | { kind: 'created' }
  // An account already exists for this email: the screen offers Sign in instead.
  | { kind: 'account_exists' }
  | { kind: 'failed' }
  | { kind: 'unavailable' };

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

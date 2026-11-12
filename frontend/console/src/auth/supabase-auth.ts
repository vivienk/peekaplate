import { type AuthError, createClient, type User } from '@supabase/supabase-js';
import type { OwnerAuthService } from './auth-service';

const CONSOLE_ORIGINS = new Set([
  'http://127.0.0.1:5174',
  'https://peekaplate-console-staging.pages.dev',
  'https://peekaplate.app',
]);

export type OwnerAuthConfig = {
  url: string;
  publishableKey: string;
  confirmationUrl: string;
};

export function readOwnerAuthConfig(
  environment: Readonly<Record<string, unknown>>,
  origin: string,
): OwnerAuthConfig | null {
  if (environment.VITE_OWNER_AUTH_ENABLED !== 'true' || !CONSOLE_ORIGINS.has(origin)) return null;
  const key = environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return null;
  try {
    const url = new URL(String(environment.VITE_SUPABASE_URL));
    if (
      url.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null;
    return { url: url.origin, publishableKey: key, confirmationUrl: `${origin}/auth-confirm.html` };
  } catch {
    return null;
  }
}

function providerFailure(error: AuthError): { kind: 'rate_limited' | 'failed' } {
  return { kind: error.status === 429 ? 'rate_limited' : 'failed' };
}

function confirmed(user: User | null): user is User {
  return Boolean(
    user?.email_confirmed_at && user.email && user.role === 'authenticated' && !user.is_anonymous,
  );
}

export type SignedInOwner = { id: string; email: string };

export function connectOwnerAuth(config: OwnerAuthConfig, fetcher: typeof fetch = fetch) {
  let recoveryOwnerId: string | null = null;
  const client = createClient(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, debug: false },
    global: {
      fetch: (input, init) =>
        fetcher(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)])
            : AbortSignal.timeout(12_000),
        }),
    },
  });

  async function signedInOwner(): Promise<SignedInOwner | null> {
    const { data, error } = await client.auth.getUser();
    return !error && confirmed(data.user) ? { id: data.user.id, email: data.user.email! } : null;
  }

  async function signOut(): Promise<boolean> {
    recoveryOwnerId = null;
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      return !error;
    } catch {
      return false;
    }
  }

  function onSignedOut(callback: () => void) {
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') callback();
    });
    return () => data.subscription.unsubscribe();
  }

  const service: OwnerAuthService = {
    async checkEmail() {
      return { kind: 'continue_to_sign_in' };
    },
    async signIn(request) {
      recoveryOwnerId = null;
      try {
        const { error } = await client.auth.signInWithPassword(request);
        if (error?.code === 'invalid_credentials' || error?.code === 'user_not_found')
          return { kind: 'invalid_credentials' };
        if (error?.code === 'email_not_confirmed') return { kind: 'email_not_confirmed' };
        if (error) return providerFailure(error);
        if (await signedInOwner()) return { kind: 'signed_in' };
        await signOut();
        return { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },
    async createAccount(request) {
      if (!request.acceptedTerms) return { kind: 'failed' };
      try {
        const { data, error } = await client.auth.signUp({
          email: request.email,
          password: request.password,
          options: {
            emailRedirectTo: config.confirmationUrl,
            data: { full_name: request.fullName },
          },
        });
        // Existing accounts and obfuscated successful replies share the same neutral screen.
        if (error?.code === 'user_already_exists' || error?.code === 'email_exists')
          return { kind: 'confirmation_required' };
        if (error?.code === 'weak_password') return { kind: 'weak_password' };
        if (error) return providerFailure(error);
        // Confirmation must remain enabled in the project. Never auto-enter on unexpected sessions.
        if (data.session) {
          await signOut();
          return { kind: 'failed' };
        }
        return { kind: 'confirmation_required' };
      } catch {
        return { kind: 'failed' };
      }
    },
    async requestPasswordReset(email) {
      try {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: new URL('/auth-reset.html', config.confirmationUrl).href,
        });
        if (error && error.code !== 'user_not_found') return providerFailure(error);
        return { kind: 'sent', resendAfterSeconds: 60 };
      } catch {
        return { kind: 'failed' };
      }
    },
    async resetPassword(password) {
      if (!recoveryOwnerId) return { kind: 'invalid_link' };
      try {
        const owner = await signedInOwner();
        if (!owner || owner.id !== recoveryOwnerId) {
          recoveryOwnerId = null;
          return { kind: 'invalid_link' };
        }
        const { error } = await client.auth.updateUser({ password });
        if (error?.code === 'weak_password') return { kind: 'weak_password' };
        if (error?.code === 'same_password') return { kind: 'same_password' };
        if (error?.status === 401 || error?.status === 403) {
          recoveryOwnerId = null;
          return { kind: 'invalid_link' };
        }
        if (error) return providerFailure(error);
        recoveryOwnerId = null;
        const signedOut = await signOut();
        return {
          kind: 'updated',
          email: owner.email,
          ...(!signedOut ? { signOutPending: true as const } : {}),
        };
      } catch {
        return { kind: 'failed' };
      }
    },
  };

  async function confirmEmail(code: string): Promise<{ kind: 'confirmed' | 'invalid_link' }> {
    if (!code || code.length > 2048) return { kind: 'invalid_link' };
    let recovery = false;
    const { data: listener } = client.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') recovery = true;
    });
    try {
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) return { kind: 'invalid_link' };
      const owner = !recovery ? await signedInOwner() : null;
      const signedOut = await signOut();
      return { kind: owner && signedOut ? 'confirmed' : 'invalid_link' };
    } catch {
      return { kind: 'invalid_link' };
    } finally {
      listener.subscription.unsubscribe();
    }
  }

  async function openRecovery(
    code: string,
  ): Promise<{ kind: 'ready'; email: string } | { kind: 'invalid_link' }> {
    recoveryOwnerId = null;
    if (!code || code.length > 2048) return { kind: 'invalid_link' };
    let recovery = false;
    const { data: listener } = client.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') recovery = true;
    });
    try {
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) return { kind: 'invalid_link' };
      const owner = recovery ? await signedInOwner() : null;
      if (!owner) {
        await signOut();
        return { kind: 'invalid_link' };
      }
      recoveryOwnerId = owner.id;
      return { kind: 'ready', email: owner.email };
    } catch {
      return { kind: 'invalid_link' };
    } finally {
      listener.subscription.unsubscribe();
    }
  }

  return { service, signedInOwner, signOut, onSignedOut, confirmEmail, openRecovery };
}

export type OwnerAuthRuntime = ReturnType<typeof connectOwnerAuth>;

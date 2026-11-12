import {
  type AuthError,
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
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
  let recovery: {
    client: SupabaseClient;
    owner: SignedInOwner;
    accessToken: string;
    abort: AbortController;
  } | null = null;
  let sessionVersion = 0;
  function clearRecovery() {
    sessionVersion++;
    recovery?.abort.abort();
    recovery = null;
  }
  function providerClient(persistent: boolean, signal?: AbortSignal) {
    return createClient(config.url, config.publishableKey, {
      auth: {
        flowType: 'pkce',
        detectSessionInUrl: false,
        persistSession: persistent,
        autoRefreshToken: persistent,
        debug: false,
        ...(!persistent ? { storageKey: 'peekaplate-owner-recovery' } : {}),
      },
      global: {
        fetch: (input, init) =>
          fetcher(input, {
            ...init,
            signal: AbortSignal.any([
              AbortSignal.timeout(12_000),
              ...(init?.signal ? [init.signal] : []),
              ...(signal ? [signal] : []),
            ]),
          }),
      },
    });
  }
  const client = providerClient(true);
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')
      clearRecovery();
  });

  async function signedInOwner(): Promise<SignedInOwner | null> {
    const { data, error } = await client.auth.getUser();
    return !error && confirmed(data.user) ? { id: data.user.id, email: data.user.email! } : null;
  }

  async function signOut(): Promise<boolean> {
    clearRecovery();
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

  async function discardExchangedSession(accessToken: string) {
    const { data } = await client.auth.getSession();
    if (data.session?.access_token === accessToken) await signOut();
  }

  const service: OwnerAuthService = {
    async checkEmail() {
      return { kind: 'continue_to_sign_in' };
    },
    async signIn(request) {
      clearRecovery();
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
    async resendConfirmation(email) {
      try {
        const { error } = await client.auth.resend({
          type: 'signup',
          email,
          options: { emailRedirectTo: config.confirmationUrl },
        });
        if (error) return providerFailure(error);
        return { kind: 'sent' };
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
      const active = recovery;
      if (!active) return { kind: 'invalid_link' };
      try {
        const { data: checked, error: checkError } = await active.client.auth.getUser();
        if (
          recovery !== active ||
          checkError ||
          !confirmed(checked.user) ||
          checked.user.id !== active.owner.id
        ) {
          clearRecovery();
          return { kind: 'invalid_link' };
        }
        // Private in-memory SDK session prevents another tab changing the password request's actor.
        const { error } = await active.client.auth.updateUser({ password });
        if (error?.code === 'weak_password') return { kind: 'weak_password' };
        if (error?.code === 'same_password') return { kind: 'same_password' };
        if (error?.status === 401 || error?.status === 403) {
          clearRecovery();
          return { kind: 'invalid_link' };
        }
        if (error) return providerFailure(error);
        const { error: revokeError } = await active.client.auth.signOut({ scope: 'local' });
        const { data: current } = await client.auth.getSession();
        const signedOut =
          current.session?.access_token === active.accessToken ? await signOut() : !revokeError;
        clearRecovery();
        return {
          kind: 'updated',
          email: active.owner.email,
          ...(!signedOut ? { signOutPending: true as const } : {}),
        };
      } catch {
        return { kind: recovery === active ? 'failed' : 'invalid_link' };
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
    clearRecovery();
    const version = sessionVersion;
    if (!code || code.length > 2048) return { kind: 'invalid_link' };
    let recoveryToken: string | null = null;
    const { data: listener } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') recoveryToken = session?.access_token ?? null;
    });
    try {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error) return { kind: 'invalid_link' };
      if (
        !data.session ||
        recoveryToken !== data.session.access_token ||
        sessionVersion !== version
      ) {
        if (data.session) await discardExchangedSession(data.session.access_token);
        return { kind: 'invalid_link' };
      }
      const abort = new AbortController();
      const isolated = providerClient(false, abort.signal);
      const { data: verified, error: verifyError } = await isolated.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      if (verifyError || !confirmed(verified.user) || sessionVersion !== version) {
        abort.abort();
        await discardExchangedSession(data.session.access_token);
        return { kind: 'invalid_link' };
      }
      recovery = {
        client: isolated,
        owner: { id: verified.user.id, email: verified.user.email! },
        accessToken: data.session.access_token,
        abort,
      };
      return { kind: 'ready', email: recovery.owner.email };
    } catch {
      return { kind: 'invalid_link' };
    } finally {
      listener.subscription.unsubscribe();
    }
  }

  return { service, signedInOwner, signOut, onSignedOut, confirmEmail, openRecovery };
}

export type OwnerAuthRuntime = ReturnType<typeof connectOwnerAuth>;

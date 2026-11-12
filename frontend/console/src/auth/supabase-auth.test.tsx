import { describe, expect, it } from 'vitest';
import { connectOwnerAuth, readOwnerAuthConfig } from './supabase-auth';

const origin = 'http://127.0.0.1:5174';
const environment = {
  VITE_OWNER_AUTH_ENABLED: 'true',
  VITE_SUPABASE_URL: 'https://synthetic.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_fixture_only',
};
const user = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'owner@example.test',
  email_confirmed_at: '2026-11-11T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-11-11T00:00:00Z',
};
const session = {
  access_token: 'synthetic-access-token',
  refresh_token: 'synthetic-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  user,
};

function fixture(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected synthetic provider request');
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' },
    });
  };
  const config = readOwnerAuthConfig(environment, origin);
  if (!config) throw new Error('Fixture configuration rejected');
  const runtime = connectOwnerAuth(config, fetcher);
  return { runtime, calls };
}

describe('owner provider configuration', () => {
  it('is off by default and accepts only exact trusted origins and public keys', () => {
    expect(readOwnerAuthConfig({}, origin)).toBeNull();
    expect(
      readOwnerAuthConfig(environment, 'https://pr-143.peekaplate-console-preview.pages.dev'),
    ).toBeNull();
    expect(
      readOwnerAuthConfig(environment, 'https://peekaplate-console-staging.pages.dev.evil.test'),
    ).toBeNull();
    expect(
      readOwnerAuthConfig(
        { ...environment, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_never_a_browser_key' },
        origin,
      ),
    ).toBeNull();
    expect(
      readOwnerAuthConfig({ ...environment, VITE_SUPABASE_URL: 'https://evil.test' }, origin),
    ).toBeNull();
    expect(readOwnerAuthConfig(environment, origin)?.confirmationUrl).toBe(
      `${origin}/auth-confirm.html`,
    );
  });
});

describe('Supabase owner adapter (real SDK, synthetic HTTP)', () => {
  it('continues neutrally without looking up whether an email exists', async () => {
    const { runtime, calls } = fixture([]);
    expect(await runtime.service.checkEmail('owner@example.test')).toEqual({
      kind: 'continue_to_sign_in',
    });
    expect(calls).toHaveLength(0);
  });

  it('verifies the provider user before returning signed_in', async () => {
    const { runtime, calls } = fixture([{ body: session }, { body: user }]);
    expect(
      await runtime.service.signIn({ email: 'owner@example.test', password: 'fixture-password' }),
    ).toEqual({ kind: 'signed_in' });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/auth/v1/token',
      '/auth/v1/user',
    ]);
  });

  it.each([
    ['invalid_credentials', 400, 'invalid_credentials'],
    ['email_not_confirmed', 400, 'email_not_confirmed'],
    ['over_request_rate_limit', 429, 'rate_limited'],
    ['unexpected_failure', 500, 'failed'],
  ])('maps %s centrally without copying provider messages', async (code, status, kind) => {
    const { runtime } = fixture([{ status, body: { code, msg: 'private provider detail' } }]);
    expect(
      await runtime.service.signIn({ email: 'owner@example.test', password: 'fixture-password' }),
    ).toEqual({ kind });
  });

  it('requests a PKCE confirmation at the exact callback and does not claim restaurant access', async () => {
    const { runtime, calls } = fixture([{ body: { user, session: null } }]);
    expect(
      await runtime.service.createAccount({
        fullName: 'Synthetic Owner',
        email: 'owner@example.test',
        password: 'fixture-password',
        acceptedTerms: true,
      }),
    ).toEqual({ kind: 'confirmation_required' });
    expect(new URL(calls[0]!.url).searchParams.get('redirect_to')).toBe(
      `${origin}/auth-confirm.html`,
    );
    expect(calls[0]!.body).toMatchObject({
      data: { full_name: 'Synthetic Owner' },
      code_challenge_method: 's256',
    });
    expect(JSON.stringify(calls)).not.toMatch(/venue_id|permission|staff_membership/);
  });

  it('keeps existing-account signup responses neutral', async () => {
    const { runtime } = fixture([
      { status: 422, body: { code: 'user_already_exists', msg: 'exists' } },
    ]);
    expect(
      await runtime.service.createAccount({
        fullName: 'Synthetic Owner',
        email: 'owner@example.test',
        password: 'fixture-password',
        acceptedTerms: true,
      }),
    ).toEqual({ kind: 'confirmation_required' });
  });

  it('does not treat an arbitrary existing session or empty callback as confirmation', async () => {
    const { runtime, calls } = fixture([]);
    expect(await runtime.confirmEmail('')).toEqual({ kind: 'invalid_link' });
    expect(calls).toHaveLength(0);
  });

  it('exchanges the current signup code, verifies the confirmed user, and signs the callback out', async () => {
    const { runtime, calls } = fixture([
      { body: { user, session: null } },
      { body: session },
      { body: user },
      { body: {} },
    ]);
    await runtime.service.createAccount({
      fullName: 'Synthetic Owner',
      email: 'owner@example.test',
      password: 'fixture-password',
      acceptedTerms: true,
    });
    expect(await runtime.confirmEmail('synthetic-code')).toEqual({ kind: 'confirmed' });
    expect(new URL(calls[1]!.url).searchParams.get('grant_type')).toBe('pkce');
    expect(calls[1]!.body).toMatchObject({
      auth_code: 'synthetic-code',
      code_verifier: expect.any(String),
    });
    expect(new URL(calls.at(-1)!.url).pathname).toBe('/auth/v1/logout');
  });

  it('rejects expired/reused codes and does not claim confirmation', async () => {
    const { runtime } = fixture([
      { body: { user, session: null } },
      { status: 400, body: { code: 'flow_state_expired' } },
    ]);
    await runtime.service.createAccount({
      fullName: 'Synthetic Owner',
      email: 'owner@example.test',
      password: 'fixture-password',
      acceptedTerms: true,
    });
    expect(await runtime.confirmEmail('expired-code')).toEqual({ kind: 'invalid_link' });
    expect(await runtime.confirmEmail('expired-code')).toEqual({ kind: 'invalid_link' });
  });
});

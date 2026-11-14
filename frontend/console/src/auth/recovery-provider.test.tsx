import { describe, expect, it } from 'vitest';
import { connectOwnerAuth, readOwnerAuthConfig } from './supabase-auth';

const email = 'owner@example.test';
const user = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email,
  email_confirmed_at: '2026-11-11T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-11-11T00:00:00Z',
};
const session = {
  access_token: `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.c3ludGhldGlj`,
  refresh_token: 'synthetic-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  user,
};
function fixture(responses: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const config = readOwnerAuthConfig(
    {
      VITE_OWNER_AUTH_ENABLED: 'true',
      VITE_SUPABASE_URL: 'https://synthetic.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_fixture_only',
    },
    'http://127.0.0.1:5174',
  )!;
  const runtime = connectOwnerAuth(config, async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = responses.shift();
    if (!answer) throw new Error('Unexpected synthetic request');
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' },
    });
  });
  return { runtime, calls };
}
describe('recovery session authority', () => {
  it('cannot reset from a plain signed-in session or a direct page visit', async () => {
    const { runtime, calls } = fixture([{ body: session }, { body: user }]);
    await runtime.service.signIn({ email, password: 'synthetic-password' });
    expect(await runtime.service.resetPassword('new-synthetic-password')).toEqual({
      kind: 'invalid_link',
    });
    expect(calls).toHaveLength(2);
  });
  it('requests neutral recovery with exact redirect and updates only after its exchange', async () => {
    const { runtime, calls } = fixture([
      { body: {} },
      { body: session },
      { body: user },
      { body: user },
      { body: { user } },
      { body: {} },
      { body: {} },
    ]);
    expect(await runtime.service.requestPasswordReset(email)).toEqual({
      kind: 'sent',
      resendAfterSeconds: 60,
    });
    expect(new URL(calls[0]!.url).searchParams.get('redirect_to')).toBe(
      'http://127.0.0.1:5174/auth-reset.html',
    );
    expect(await runtime.openRecovery('recovery-code')).toEqual({ kind: 'ready', email });
    expect(await runtime.service.resetPassword('new-synthetic-password')).toEqual({
      kind: 'updated',
      email,
    });
    expect(
      calls.filter((call) => new URL(call.url).pathname.endsWith('/user') && Boolean(call.body)),
    ).toEqual([
      {
        url: 'https://synthetic.supabase.co/auth/v1/user',
        body: {
          password: 'new-synthetic-password',
          code_challenge: null,
          code_challenge_method: null,
        },
      },
    ]);
    expect(await runtime.service.resetPassword('another-password')).toEqual({
      kind: 'invalid_link',
    });
  });
  it('rejects a signup exchange on the reset page', async () => {
    const { runtime, calls } = fixture([
      { body: { user, session: null } },
      { body: session },
      { body: {} },
    ]);
    await runtime.service.createAccount({
      fullName: 'Synthetic Owner',
      email,
      password: 'synthetic-password',
      acceptedTerms: true,
    });
    expect(await runtime.openRecovery('signup-code')).toEqual({ kind: 'invalid_link' });
    expect(await runtime.service.resetPassword('new-password')).toEqual({ kind: 'invalid_link' });
    expect(
      calls.some(
        (call) =>
          Boolean((call.body as { password?: unknown } | null)?.password) &&
          new URL(call.url).pathname.endsWith('/user'),
      ),
    ).toBe(false);
  });
  it('does not sign out an existing owner on a failed recovery exchange', async () => {
    const { runtime, calls } = fixture([
      { body: session },
      { body: user },
      { body: {} },
      { status: 400, body: { code: 'flow_state_expired' } },
      { body: user },
    ]);
    await runtime.service.signIn({ email, password: 'synthetic-password' });
    await runtime.service.requestPasswordReset(email);
    expect(await runtime.openRecovery('expired-code')).toEqual({ kind: 'invalid_link' });
    expect(await runtime.signedInOwner()).toEqual({ id: user.id, email });
    expect(calls.some((call) => new URL(call.url).pathname.endsWith('/logout'))).toBe(false);
  });
});

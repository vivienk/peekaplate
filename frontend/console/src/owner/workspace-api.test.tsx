import { describe, expect, it, vi } from 'vitest';
import { createRestaurant, fetchOwnerWorkspace, readWorkspaceApiBase } from './workspace-api';

const apiBase = 'https://peekaplate-api-staging.vxkong.workers.dev';
const actorId = '11111111-1111-4111-8111-111111111111';
const venue = {
  venueId: '22222222-2222-4222-8222-222222222222',
  name: 'Synthetic restaurant',
  permission: 'owner',
};
const signal = new AbortController().signal;
const commandId = '33333333-3333-4333-8333-333333333333';

describe('restaurant creation client', () => {
  const options = {
    apiBase,
    getAccessToken: async () => 'synthetic-token',
    signal,
    commandId,
    name: '  Synthetic restaurant  ',
  };
  it('sends only the stable command and trimmed name using authenticated transport', async () => {
    const send = vi.fn(async () => Response.json({ venue }));
    expect(await createRestaurant({ ...options, fetch: send })).toEqual({
      kind: 'created',
      venue,
    });
    expect(send).toHaveBeenCalledWith(
      `${apiBase}/staff/venues`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        body: JSON.stringify({ commandId, name: 'Synthetic restaurant' }),
        headers: {
          Authorization: 'Bearer synthetic-token',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }),
    );
  });
  it('does not send after cancellation during token lookup or to an unsupported origin', async () => {
    const send = vi.fn();
    const controller = new AbortController();
    await createRestaurant({
      ...options,
      signal: controller.signal,
      getAccessToken: async () => {
        controller.abort();
        return 'synthetic-token';
      },
      fetch: send,
    });
    expect(
      await createRestaurant({ ...options, apiBase: 'https://evil.test', fetch: send }),
    ).toEqual({ kind: 'unavailable' });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'signed_out'],
    [403, 'denied'],
    [409, 'conflict'],
    [429, 'quota'],
    [503, 'unavailable'],
  ] as const)('preserves creation failure %s', async (status, kind) => {
    expect(
      await createRestaurant({ ...options, fetch: async () => new Response('{}', { status }) }),
    ).toEqual({ kind });
  });
  it('rejects invented permissions and invalid input before sending', async () => {
    expect(
      await createRestaurant({
        ...options,
        fetch: async () => Response.json({ venue: { ...venue, permission: 'editor' } }),
      }),
    ).toEqual({ kind: 'invalid' });
    const send = vi.fn();
    expect(await createRestaurant({ ...options, name: ' ', fetch: send })).toEqual({
      kind: 'invalid',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('owner workspace client', () => {
  it('only accepts exact configured API origins', () => {
    expect(readWorkspaceApiBase(apiBase)).toBe(apiBase);
    expect(readWorkspaceApiBase('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(readWorkspaceApiBase('https://api.peekaplate.app')).toBe('https://api.peekaplate.app');
    for (const value of [
      undefined,
      `${apiBase}.evil.test`,
      `${apiBase}/other`,
      `${apiBase}?next=elsewhere`,
      'https://user@peekaplate-api-staging.vxkong.workers.dev',
      'http://localhost:8787',
    ])
      expect(readWorkspaceApiBase(value)).toBeNull();
  });
  it('uses the actor-bound token without cookies, redirects, caching or caller authority fields', async () => {
    const send = vi.fn(async () => Response.json({ actorId, venues: [venue] }));
    const state = await fetchOwnerWorkspace({
      apiBase,
      actorId,
      getAccessToken: async () => 'synthetic-token',
      signal,
      fetch: send,
    });
    expect(state).toEqual({ kind: 'ready', venues: [venue] });
    expect(send).toHaveBeenCalledWith(
      `${apiBase}/staff/venues`,
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: { Authorization: 'Bearer synthetic-token', Accept: 'application/json' },
      }),
    );
  });
  it('never sends an absent session or a token to an untrusted API', async () => {
    const send = vi.fn();
    expect(
      await fetchOwnerWorkspace({
        apiBase,
        actorId,
        getAccessToken: async () => null,
        signal,
        fetch: send,
      }),
    ).toEqual({ kind: 'signed_out' });
    expect(
      await fetchOwnerWorkspace({
        apiBase: 'https://evil.test',
        actorId,
        getAccessToken: async () => 'synthetic-token',
        signal,
        fetch: send,
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects another actor, malformed permission and duplicated venue responses', async () => {
    for (const body of [
      { actorId: venue.venueId, venues: [venue] },
      { actorId, venues: [{ ...venue, permission: 'admin' }] },
      { actorId, venues: [venue, venue] },
    ]) {
      expect(
        await fetchOwnerWorkspace({
          apiBase,
          actorId,
          getAccessToken: async () => 'synthetic-token',
          signal,
          fetch: async () => Response.json(body),
        }),
      ).toEqual({ kind: 'invalid' });
    }
  });
  it('preserves denial and unavailable states rather than inventing empty access', async () => {
    for (const [status, kind] of [
      [401, 'signed_out'],
      [403, 'denied'],
      [404, 'unavailable'],
      [503, 'unavailable'],
      [500, 'error'],
    ] as const) {
      expect(
        await fetchOwnerWorkspace({
          apiBase,
          actorId,
          getAccessToken: async () => 'synthetic-token',
          signal,
          fetch: async () => new Response('{}', { status }),
        }),
      ).toEqual({ kind });
    }
  });
});

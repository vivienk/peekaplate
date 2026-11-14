import { describe, expect, it, vi } from 'vitest';
import { fetchOwnerWorkspace, readWorkspaceApiBase } from './workspace-api';

const apiBase = 'https://peekaplate-api-staging.vxkong.workers.dev';
const actorId = '11111111-1111-4111-8111-111111111111';
const venue = {
  venueId: '22222222-2222-4222-8222-222222222222',
  name: 'Synthetic restaurant',
  permission: 'owner',
};
const signal = new AbortController().signal;

describe('owner workspace client', () => {
  it('only accepts the exact configured local/staging API origin', () => {
    expect(readWorkspaceApiBase(apiBase)).toBe(apiBase);
    expect(readWorkspaceApiBase('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
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

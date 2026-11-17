import { describe, expect, it, vi } from 'vitest';
import { fetchOwnerActions } from './owner-actions-api';

const venueId = '00000000-0000-4000-8000-000000000123';
const options = () => ({
  apiBase: 'http://127.0.0.1:8787',
  venueId,
  getAccessToken: async () => 'owner-token',
  signal: new AbortController().signal,
});
describe('saved owner actions reader', () => {
  it('reads actual empty results with owner auth and no browser credentials/cache', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, actions: [] })));
    expect(await fetchOwnerActions({ ...options(), fetch: send })).toEqual({
      kind: 'ready',
      actions: [],
    });
    expect(send.mock.calls[0]).toEqual([
      `http://127.0.0.1:8787/venues/${venueId}/owner-insight-actions?limit=100`,
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: { Authorization: 'Bearer owner-token', Accept: 'application/json' },
      }),
    ]);
  });
  it('keeps failed or invalid responses distinct from no saved actions', async () => {
    for (const response of [
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify({ schemaVersion: 1, actions: [{}] })),
    ]) {
      expect(await fetchOwnerActions({ ...options(), fetch: async () => response })).toEqual({
        kind: 'unavailable',
      });
    }
  });
  it('does not fetch without a session and preserves access failures', async () => {
    const send = vi.fn();
    expect(
      await fetchOwnerActions({ ...options(), getAccessToken: async () => null, fetch: send }),
    ).toEqual({ kind: 'signed_out' });
    expect(send).not.toHaveBeenCalled();
    for (const [status, kind] of [
      [401, 'signed_out'],
      [403, 'denied'],
    ] as const)
      expect(
        await fetchOwnerActions({
          ...options(),
          fetch: async () => new Response(null, { status }),
        }),
      ).toEqual({ kind });
  });
  it('rejects otherwise valid records belonging to another venue', async () => {
    const action = {
      actionId: venueId,
      venueId: '00000000-0000-4000-8000-000000000456',
      insightKey: 'actual-insight',
      menuId: venueId,
      menuRevisionId: venueId,
      category: 'description_update',
      status: 'active',
      note: null,
      version: 1,
      createdBy: venueId,
      updatedBy: venueId,
      createdAt: '2026-11-17T00:00:00Z',
      updatedAt: '2026-11-17T00:00:00Z',
    };
    expect(
      await fetchOwnerActions({
        ...options(),
        fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, actions: [action] })),
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await fetchOwnerActions({
        ...options(),
        fetch: async () =>
          new Response(JSON.stringify({ schemaVersion: 1, actions: [{ ...action, venueId }] })),
      }),
    ).toEqual({ kind: 'ready', actions: [{ ...action, venueId }] });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createApp } from './index';
import { PublicationCommandError } from './publication-command';

const venueId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const path = `/venues/${venueId}/prepared-menus`;
const headers = { Authorization: 'Bearer synthetic-only' };
const env = { APP_ENV: 'staging' };

describe('prepared menu HTTP boundary', () => {
  it('authenticates and never fetches content on denial, missing admission or production', async () => {
    const listPreparedMenus = vi.fn(async () => []);
    const fetchPreparedMenu = vi.fn();
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      listPreparedMenus,
      fetchPreparedMenu,
    });
    expect((await app.request(path, {}, env)).status).toBe(401);
    expect(listPreparedMenus).not.toHaveBeenCalled();
    expect(
      (
        await app.request(
          `https://api.peekaplate.app${path}`,
          { headers },
          { APP_ENV: 'production' },
        )
      ).status,
    ).toBe(404);
    expect((await app.request(`${path}?venueId=other`, { headers }, env)).status).toBe(400);
    expect((await app.request(`${path}/${actorId}/${actorId}`, { headers }, env)).status).toBe(404);
    expect(fetchPreparedMenu).not.toHaveBeenCalled();
    listPreparedMenus.mockRejectedValueOnce(new PublicationCommandError('forbidden', 403));
    expect((await app.request(path, { headers }, env)).status).toBe(403);
    expect(fetchPreparedMenu).not.toHaveBeenCalled();
  });

  it('keeps prepared menus and preparation actor-scoped when production is enabled', async () => {
    const listPreparedMenus = vi.fn(async () => []);
    const prepareOwnerMenu = vi
      .fn()
      .mockRejectedValue(new PublicationCommandError('forbidden', 403));
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      listPreparedMenus,
      fetchPreparedMenu: vi.fn(),
      prepareOwnerMenu,
    });
    const production = { APP_ENV: 'production', OWNER_WORKFLOW_ENABLED: 'true' };
    const origin = 'https://peekaplate.app';
    const req = { headers: { ...headers, Origin: origin } };
    const response = await app.request(`https://api.peekaplate.app${path}`, req, production);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(listPreparedMenus).toHaveBeenCalledWith(actorId, venueId, production);
    const denied = await app.request(
      `https://api.peekaplate.app${path}/prepare`,
      { ...req, method: 'POST' },
      production,
    );
    expect(denied.status).toBe(403);
    expect(prepareOwnerMenu).toHaveBeenCalledWith(
      actorId,
      venueId,
      'https://api.peekaplate.app',
      production,
    );
  });

  it('uses the verified actor and exact console origin with private no-store reads', async () => {
    const listPreparedMenus = vi.fn(async () => []);
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      listPreparedMenus,
      fetchPreparedMenu: vi.fn(),
    });
    const response = await app.request(
      path,
      { headers: { ...headers, Origin: 'https://peekaplate-console-staging.pages.dev' } },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ menus: [] });
    expect(listPreparedMenus).toHaveBeenCalledWith(actorId, venueId, env);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://peekaplate-console-staging.pages.dev',
    );
    const blocked = await app.request(
      path,
      { headers: { ...headers, Origin: 'https://example.test' } },
      env,
    );
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

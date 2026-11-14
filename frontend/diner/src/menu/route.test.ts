import { describe, expect, it, vi } from 'vitest';
import { menuRouteFromPath, resolveMenuRoute } from './route';

const venueId = '11111111-1111-4111-8111-111111111111';
const menuId = '22222222-2222-4222-8222-222222222222';
const scope = { venueId, menuId };
const apiBase = 'https://api.example.test';
describe('published menu routes', () => {
  it('preserves canonical links without looking up an alias', async () => {
    const fetcher = vi.fn();
    for (const prefix of ['', '/diner']) {
      const path = `${prefix}/venues/${venueId}/menus/${menuId}/`;
      expect(menuRouteFromPath(path)).toEqual(scope);
      expect(await resolveMenuRoute(path, { apiBase, fetcher })).toEqual(scope);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the live server locator without accepting query authority', async () => {
    const fetcher = vi.fn(async () => Response.json(scope));
    expect(await resolveMenuRoute('/diner/noka_ramen/', { apiBase, fetcher })).toEqual(scope);
    expect(fetcher).toHaveBeenCalledWith(`${apiBase}/public/restaurants/noka_ramen`, {
      cache: 'no-store',
      credentials: 'omit',
    });
  });
  it.each([
    '/',
    '/owner/',
    '/diner/',
    '/diner/assets',
    '/diner/constructor',
    '/diner/Noka_Ramen',
    '/diner/noka%2Framen',
    '/diner/noka/extra',
    `/venues/abc/menus/${menuId}`,
  ])('rejects malformed path %s before requesting', async (path) => {
    const fetcher = vi.fn();
    expect(await resolveMenuRoute(path, { apiBase, fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('treats missing/withdrawn links as unavailable and propagates failure', async () => {
    expect(
      await resolveMenuRoute('/diner/unknown', {
        apiBase,
        fetcher: async () => new Response(null, { status: 404 }),
      }),
    ).toBeNull();
    await expect(
      resolveMenuRoute('/diner/noka', {
        apiBase,
        fetcher: async () => new Response(null, { status: 503 }),
      }),
    ).rejects.toThrow();
  });
  it.each([
    { ...scope, menuToken: 'untrusted' },
    { ...scope, menuId: '../private' },
  ])('rejects malformed locators', async (body) => {
    await expect(
      resolveMenuRoute('/diner/noka', { apiBase, fetcher: async () => Response.json(body) }),
    ).rejects.toThrow();
  });
  it('rejects a locator completed after cancellation', async () => {
    const controller = new AbortController();
    await expect(
      resolveMenuRoute('/diner/noka', {
        apiBase,
        signal: controller.signal,
        fetcher: async () => {
          controller.abort();
          return Response.json(scope);
        },
      }),
    ).rejects.toThrow();
  });
});

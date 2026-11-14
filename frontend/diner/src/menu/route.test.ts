import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { menuRouteFromPath, parseRestaurantLinks, resolveMenuRoute } from './route';

const V = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';

describe('menuRouteFromPath', () => {
  it('reads the venue and menu ids', () => {
    expect(menuRouteFromPath(`/venues/${V}/menus/${M}`)).toEqual({ venueId: V, menuId: M });
    expect(menuRouteFromPath(`/venues/${V}/menus/${M}/`)).toEqual({ venueId: V, menuId: M });
    expect(menuRouteFromPath(`/diner/venues/${V}/menus/${M}`)).toEqual({ venueId: V, menuId: M });
  });
  it('returns null for other paths or non-UUID ids', () => {
    expect(menuRouteFromPath('/')).toBeNull();
    expect(menuRouteFromPath(`/venues/abc/menus/${M}`)).toBeNull();
    expect(menuRouteFromPath(`/venues/${V}/menus/${M}/extra`)).toBeNull();
  });
});

const links = { schemaVersion: 1, restaurants: [{ slug: 'noka_ramen', venueId: V, menuId: M }] };
const fetchLinks =
  (body: unknown = links) =>
  async () =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('restaurant links', () => {
  it('validates the actual shipped directory', () => {
    expect(() =>
      parseRestaurantLinks(
        JSON.parse(readFileSync('frontend/diner/public/config/restaurant-links.json', 'utf8')),
      ),
    ).not.toThrow();
  });
  it('resolves the exact restaurant without using query parameters as authority', async () => {
    const requests: string[] = [];
    const route = await resolveMenuRoute('/diner/noka_ramen/', {
      linksUrl: '/diner/restaurant-links.json',
      fetcher: async (input, init) => {
        requests.push(String(input));
        expect(init?.cache).toBe('no-store');
        expect(init?.credentials).toBe('omit');
        return fetchLinks()();
      },
    });
    expect(route).toEqual({ venueId: V, menuId: M });
    expect(requests).toEqual(['/diner/restaurant-links.json']);
  });

  it('keeps canonical links independent of the restaurant directory', async () => {
    const fetcher = async () => {
      throw new Error('directory should not be read');
    };
    expect(
      await resolveMenuRoute(`/venues/${V}/menus/${M}`, { linksUrl: '/unused', fetcher }),
    ).toEqual({ venueId: V, menuId: M });
  });

  it.each([
    '/',
    '/owner/',
    '/noka_ramen',
    '/diner/',
    '/diner/assets',
    '/diner/constructor',
    '/diner/noka_ramen/extra',
    '/diner/noka%2Framen',
    '/diner/%2e%2e',
    '/diner/Noka_Ramen',
  ])('does not claim the homepage, owner, reserved or malformed path %s', async (path) => {
    const fetcher = async () => {
      throw new Error('directory should not be read');
    };
    expect(await resolveMenuRoute(path, { linksUrl: '/unused', fetcher })).toBeNull();
  });

  it('returns unavailable for an unassigned slug and accepts an empty directory', async () => {
    expect(
      await resolveMenuRoute('/diner/unknown', { linksUrl: '/links', fetcher: fetchLinks() }),
    ).toBeNull();
    expect(parseRestaurantLinks({ schemaVersion: 1, restaurants: [] }).size).toBe(0);
  });

  it.each([
    null,
    { ...links, token: 'never-a-config-field' },
    { ...links, schemaVersion: 2 },
    { ...links, restaurants: [...links.restaurants, ...links.restaurants] },
    { ...links, restaurants: [{ ...links.restaurants[0], slug: 'owner' }] },
    { ...links, restaurants: [{ ...links.restaurants[0], menuId: '../private' }] },
    { ...links, restaurants: [{ ...links.restaurants[0], url: 'https://untrusted.example' }] },
  ])('rejects an invalid or ambiguous directory', (input) => {
    expect(() => parseRestaurantLinks(input)).toThrow();
  });

  it('propagates directory fetch failure and cancellation instead of showing fixtures', async () => {
    await expect(
      resolveMenuRoute('/diner/noka_ramen', {
        linksUrl: '/links',
        fetcher: async () => new Response(null, { status: 503 }),
      }),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveMenuRoute('/diner/noka_ramen', {
        linksUrl: '/links',
        signal: controller.signal,
        fetcher: async (_input, init) => {
          init?.signal?.throwIfAborted();
          return fetchLinks()();
        },
      }),
    ).rejects.toThrow();
  });
});

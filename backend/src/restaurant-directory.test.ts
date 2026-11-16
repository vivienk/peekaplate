import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './index';
import { listPublishedRestaurants } from './restaurant-link';

const id = '11111111-1111-4111-8111-111111111111';
describe('public restaurant directory', () => {
  it('returns validated scopes, pagination and exact public-only market CORS', async () => {
    const list = vi.fn(async () => ({
      schemaVersion: 1 as const,
      restaurants: [{ venueId: id, menuId: id }],
      nextCursor: null,
    }));
    const app = createApp({ verify: vi.fn(), execute: vi.fn(), listPublishedRestaurants: list });
    const env = { MARKET_PUBLIC_ORIGIN: 'https://market.example.test' };
    const response = await app.request(
      '/public/restaurants',
      { headers: { Origin: env.MARKET_PUBLIC_ORIGIN } },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ restaurants: [{ venueId: id, menuId: id }] });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.MARKET_PUBLIC_ORIGIN);
    expect((await app.request('/public/restaurants?after=invalid')).status).toBe(400);
    const denied = await app.request(
      '/public/restaurants',
      { headers: { Origin: 'https://market.example.test.evil' } },
      env,
    );
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const observations = await app.request(
      '/observations',
      {
        method: 'OPTIONS',
        headers: { Origin: env.MARKET_PUBLIC_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      },
      env,
    );
    expect(observations.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('bounds output and uses the last delivered venue as the continuation', async () => {
    const rows = Array.from({ length: 65 }, (_, i) => ({ venueId: `venue-${i}`, menuId: id }));
    const query = vi.fn(async () => ({ rows }));
    const page = await listPublishedRestaurants({ query } as unknown as Client, id);
    expect(page.restaurants).toHaveLength(64);
    expect(page.nextCursor).toBe('venue-63');
    expect(query).toHaveBeenCalledWith('SELECT * FROM app_private.list_published_restaurants($1)', [
      id,
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createApp } from './index';

const scope = {
  venueId: '11111111-1111-4111-8111-111111111111',
  menuId: '22222222-2222-4222-8222-222222222222',
};
describe('restaurant link HTTP boundary', () => {
  it('returns only validated public scope and exact diner CORS', async () => {
    const resolver = vi.fn(async () => scope);
    const app = createApp({ verify: vi.fn(), execute: vi.fn(), resolveRestaurantLink: resolver });
    const response = await app.request('/public/restaurants/noka_ramen?venueId=ignored', {
      headers: { Origin: 'https://peekaplate.app' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(scope);
    expect(resolver).toHaveBeenCalledWith('noka_ramen', {});
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://peekaplate.app');
    const denied = await app.request('/public/restaurants/noka_ramen', {
      headers: { Origin: 'https://peekaplate.app.evil.example' },
    });
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('rejects invalid/reserved slugs and returns the same missing state', async () => {
    const resolver = vi.fn(async () => undefined);
    const app = createApp({ verify: vi.fn(), execute: vi.fn(), resolveRestaurantLink: resolver });
    expect((await app.request('/public/restaurants/owner')).status).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    const missing = await app.request('/public/restaurants/missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });
  it('requires staff authentication and keeps the owner link separate from v1 receipts', async () => {
    const readDinerLink = vi.fn(async () => ({ path: '/diner/noka_ramen' }));
    const verify = vi.fn(async () => 'owner-actor');
    const app = createApp({ verify, execute: vi.fn(), readDinerLink });
    const path = `/venues/${scope.venueId}/menus/${scope.menuId}/diner-link`;
    expect((await app.request(path)).status).toBe(401);
    expect(readDinerLink).not.toHaveBeenCalled();
    const env = {
      APP_ENV: 'staging',
      DINER_PUBLIC_ORIGIN: 'https://routing-staging.peekaplate-diner-staging.pages.dev',
    };
    const response = await app.request(
      path,
      {
        headers: { Authorization: 'Bearer synthetic-staff-token' },
      },
      env,
    );
    expect(await response.json()).toEqual({
      path: '/diner/noka_ramen',
      url: `${env.DINER_PUBLIC_ORIGIN}/diner/noka_ramen`,
    });
    expect(readDinerLink).toHaveBeenCalledWith('owner-actor', scope.venueId, scope.menuId, env);
  });
});

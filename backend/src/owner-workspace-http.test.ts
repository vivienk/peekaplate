import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, AuthUnavailableError } from './auth';
import { createApp } from './index';

const actorId = '11111111-1111-4111-8111-111111111111';
const venue = {
  venueId: '22222222-2222-4222-8222-222222222222',
  name: 'Synthetic restaurant',
  permission: 'owner' as const,
};
const env = { APP_ENV: 'staging' };
const headers = { Authorization: 'Bearer synthetic-staff-token' };

describe('owner workspace HTTP boundary', () => {
  it('discovers restaurants only for the verified actor and never caches them', async () => {
    const verify = vi.fn(async () => actorId);
    const readOwnerVenues = vi.fn(async () => [venue]);
    const app = createApp({ verify, execute: vi.fn(), readOwnerVenues });
    const response = await app.request('/staff/venues', { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actorId, venues: [venue] });
    expect(readOwnerVenues).toHaveBeenCalledWith(actorId, env);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('requires authentication before querying memberships', async () => {
    const readOwnerVenues = vi.fn();
    const app = createApp({
      verify: vi.fn(async () => {
        throw new AuthenticationError();
      }),
      execute: vi.fn(),
      readOwnerVenues,
    });
    expect((await app.request('/staff/venues', {}, env)).status).toBe(401);
    expect((await app.request('/staff/venues', { headers }, env)).status).toBe(401);
    expect(readOwnerVenues).not.toHaveBeenCalled();
  });

  it('returns an honest empty list without creating access', async () => {
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      readOwnerVenues: async () => [],
    });
    const response = await app.request('/staff/venues', { headers }, env);
    expect(await response.json()).toEqual({ actorId, venues: [] });
    expect((await app.request('/staff/venues?venueId=other', { headers }, env)).status).toBe(400);
    expect(
      (
        await app.request(
          'https://api.peekaplate.app/staff/venues',
          { headers },
          { APP_ENV: 'production' },
        )
      ).status,
    ).toBe(404);
  });

  it('allows only the exact owner origin on an explicitly enabled production Worker', async () => {
    const readOwnerVenues = vi.fn(async () => [venue]);
    const app = createApp({ verify: async () => actorId, execute: vi.fn(), readOwnerVenues });
    const production = { APP_ENV: 'production', OWNER_WORKFLOW_ENABLED: 'true' };
    const path = 'https://api.peekaplate.app/staff/venues';
    const origin = 'https://peekaplate.app';
    const result = await app.request(path, { headers: { ...headers, Origin: origin } }, production);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ actorId, venues: [venue] });
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(readOwnerVenues).toHaveBeenCalledWith(actorId, production);
    for (const blocked of ['https://diner.peekaplate.app', 'https://peekaplate.app.example.test']) {
      const denied = await app.request(path, { headers: { Origin: blocked } }, production);
      expect(denied.status).toBe(401);
      expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('fails safely if identity or database availability cannot be established', async () => {
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      readOwnerVenues: async () => {
        throw new AuthUnavailableError();
      },
    });
    const response = await app.request('/staff/venues', { headers }, env);
    expect(response.status).toBe(503);
  });

  it('exposes only exact console origins with bearer GET preflight', async () => {
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      readOwnerVenues: async () => [venue],
    });
    for (const origin of [
      'http://127.0.0.1:5174',
      'https://peekaplate-console-staging.pages.dev',
    ]) {
      const response = await app.request(
        '/staff/venues',
        {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'Authorization',
          },
        },
        env,
      );
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,OPTIONS');
    }
    const denied = await app.request(
      '/staff/venues',
      { headers: { ...headers, Origin: 'https://pr-143.peekaplate-console-preview.pages.dev' } },
      env,
    );
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

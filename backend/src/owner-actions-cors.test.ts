import { expect, it, vi } from 'vitest';
import { CONSOLE_REPORT_CORS_ALLOWED_ORIGINS, createApp } from './index';

it('permits only console GET preflights without bypassing authentication', async () => {
  const verify = vi.fn(async () => {
    throw new Error('no session');
  });
  const app = createApp({ verify, execute: vi.fn() });
  const path = '/venues/00000000-0000-4000-8000-000000000123/owner-insight-actions';
  for (const origin of CONSOLE_REPORT_CORS_ALLOWED_ORIGINS) {
    const response = await app.request(path, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization');
  }
  expect(verify).not.toHaveBeenCalled();
  const blocked = await app.request(path, {
    method: 'OPTIONS',
    headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'GET' },
  });
  expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull();
  const denied = await app.request(path, {
    headers: { Origin: CONSOLE_REPORT_CORS_ALLOWED_ORIGINS[0]! },
  });
  expect(denied.status).toBe(401);
});

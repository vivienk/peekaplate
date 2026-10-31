import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from './auth';
import { createApp } from './index';

describe('team analytics HTTP boundary', () => {
  const query = '?from=2026-10-20T06:00:00Z&until=2026-10-20T07:00:00Z';
  const actor = '00000000-0000-4000-8000-000000000003';
  const env = { APP_ENV: 'staging', POSTHOG_PROJECT_ID: '675372' };
  const headers = { Authorization: 'Bearer signed' };

  it('requires a verified individual session before reading analytics', async () => {
    const readAnalytics = vi.fn();
    const app = createApp({
      verify: vi.fn(),
      verifyTeam: async () => {
        throw new AuthenticationError();
      },
      execute: vi.fn(),
      readAnalytics,
    });
    for (const authorization of [undefined, 'Bearer forged']) {
      const response = await app.request(
        `/team/analytics/events${query}`,
        {
          headers: authorization ? { Authorization: authorization } : {},
        },
        env,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(readAnalytics).not.toHaveBeenCalled();
  });

  it('rejects broad ranges and client-supplied authority', async () => {
    const readAnalytics = vi.fn();
    const app = createApp({
      verify: vi.fn(),
      verifyTeam: async () => {},
      execute: vi.fn(),
      readAnalytics,
    });
    for (const suffix of [
      '',
      `${query}&projectId=2`,
      `${query}&actorId=${actor}`,
      `${query}&limit=101`,
      `${query}&from=2026-10-20T05:00:00Z`,
      '?from=2026-10-01T00:00:00Z&until=2026-10-20T00:00:00Z',
      '?from=2026-10-20T07:00:00Z&until=2026-10-20T06:00:00Z',
    ]) {
      expect((await app.request(`/team/analytics/events${suffix}`, { headers }, env)).status).toBe(
        400,
      );
    }
    expect(readAnalytics).not.toHaveBeenCalled();
  });

  it('keeps the endpoint unavailable outside staging/local', async () => {
    const readAnalytics = vi.fn();
    const app = createApp({ verify: vi.fn(), execute: vi.fn(), readAnalytics });
    expect(
      (await app.request(`/team/analytics/events${query}`, { headers }, { APP_ENV: 'production' }))
        .status,
    ).toBe(404);
    expect(readAnalytics).not.toHaveBeenCalled();
  });
});

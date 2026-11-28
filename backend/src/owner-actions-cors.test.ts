import { expect, it, vi } from 'vitest';
import { CONSOLE_REPORT_CORS_ALLOWED_ORIGINS, createApp } from './index';
import { OwnerInsightActionError } from './owner-insight-actions';
import { PRODUCTION_OWNER_ORIGIN } from './owner-workflow-environment';

const venueId = '00000000-0000-4000-8000-000000000123';
const path = `/venues/${venueId}/owner-insight-actions`;

it('permits only console GET preflights without bypassing authentication', async () => {
  const verify = vi.fn(async () => {
    throw new Error('no session');
  });
  const app = createApp({ verify, execute: vi.fn() });
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

it('serves authenticated production console reads only while the owner workflow is enabled', async () => {
  const actorId = '00000000-0000-4000-8000-000000000124';
  const verify = vi.fn(async () => actorId);
  const result = { schemaVersion: 1, actions: [] };
  const listOwnerActions = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockRejectedValueOnce(new OwnerInsightActionError('forbidden', 403));
  const app = createApp({ verify, execute: vi.fn(), listOwnerActions });
  const production = {
    APP_ENV: 'production',
    OWNER_WORKFLOW_ENABLED: 'true',
    OWNER_PRODUCTION_REPORTS_ENABLED: 'false',
    OWNER_AI_RESPONSES_ENABLED: 'false',
  };
  const disabled = { ...production, OWNER_WORKFLOW_ENABLED: 'false' };
  const prodUrl = `https://api.peekaplate.app${path}`;
  const preflight = (origin: string, env = production) =>
    app.request(
      prodUrl,
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      },
      env,
    );
  const allowed = await preflight(PRODUCTION_OWNER_ORIGIN);
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION_OWNER_ORIGIN);
  expect(allowed.headers.get('Access-Control-Allow-Methods')).toBe('GET,OPTIONS');
  expect(allowed.headers.get('Access-Control-Allow-Headers')).toBe('Authorization');
  for (const origin of [...CONSOLE_REPORT_CORS_ALLOWED_ORIGINS, 'https://untrusted.example']) {
    const blocked = await preflight(origin);
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull();
  }
  const disabledPreflight = await preflight(PRODUCTION_OWNER_ORIGIN, disabled);
  expect(disabledPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(verify).not.toHaveBeenCalled();
  expect(listOwnerActions).not.toHaveBeenCalled();

  const headers = { Origin: PRODUCTION_OWNER_ORIGIN, Authorization: 'Bearer signed-owner' };
  const missingToken = await app.request(
    prodUrl,
    { headers: { Origin: headers.Origin } },
    production,
  );
  expect(missingToken.status).toBe(401);
  const disabledRead = await app.request(prodUrl, { headers }, disabled);
  expect(disabledRead.status).toBe(404);
  expect(verify).not.toHaveBeenCalled();
  expect(listOwnerActions).not.toHaveBeenCalled();

  const own = await app.request(`${prodUrl}?limit=100`, { headers }, production);
  expect(own.status).toBe(200);
  expect(own.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION_OWNER_ORIGIN);
  expect(await own.json()).toEqual(result);
  expect(verify).toHaveBeenCalledWith('Bearer signed-owner', production);
  expect(listOwnerActions).toHaveBeenCalledWith(actorId, venueId, { limit: 100 }, production);

  const otherVenueId = '00000000-0000-4000-8000-000000000125';
  const denied = await app.request(
    `https://api.peekaplate.app/venues/${otherVenueId}/owner-insight-actions`,
    { headers },
    production,
  );
  expect(denied.status).toBe(403);
  expect(listOwnerActions).toHaveBeenLastCalledWith(
    actorId,
    otherVenueId,
    { limit: 50 },
    production,
  );
});

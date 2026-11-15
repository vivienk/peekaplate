import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { createOwnerAnalysisClient } from '../frontend/console/src/owner-dashboard/ai-preview/analysis-client';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from './scripts/owner-ai-local-fixture';
import { registerOwnerAnalysisRoutes } from './src/owner-ai/routes';

const baseUrl = 'http://127.0.0.1:5174';
const input = { dishId: LOCAL_AI_DISH, goal: 'menu' };

// Exercise the browser client and Worker router without mounting OwnerShell or opening a socket.
function setup() {
  const now = new Date('2026-11-12T12:00:00Z');
  const report = localOwnerAiReport(now);
  const env = {
    APP_ENV: 'local',
    SYNTHETIC_REPORT_VENUE_ID: LOCAL_AI_VENUE,
    OWNER_AI_RESPONSES_ENABLED: 'true',
    OWNER_AI_OPENAI_API_KEY: 'synthetic',
    OWNER_AI_OPENAI_PROJECT_ID: 'proj_synthetic',
  };
  const app = new Hono();
  app.onError(() => new Response('forbidden', { status: 403 }));
  const getAccessToken = vi.fn(async () => 'current-token');
  const verify = vi.fn(async () => 'current-owner');
  const readReport = vi.fn(async () => report);
  const provider = vi.fn(async () =>
    Response.json({
      model: 'gpt-6-luna',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"metric":"open_rate"}' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
    }),
  );
  registerOwnerAnalysisRoutes(app, {
    verify,
    readReport,
    fetchImpl: provider,
    now: () => now,
    allowedOrigins: [baseUrl],
    syntheticVenues: [LOCAL_AI_VENUE],
  });
  const request = vi.fn(async (url, init) => app.fetch(new Request(url, init), env));
  const client = createOwnerAnalysisClient({
    baseUrl,
    venueId: LOCAL_AI_VENUE,
    getAccessToken,
    fetchImpl: request,
  });
  return {
    env,
    report,
    getAccessToken,
    verify,
    readReport,
    provider,
    request,
    review: () => client(input, new AbortController().signal),
  };
}

it('binds AI results to the current token, venue, dish and server-read report window', async () => {
  const s = setup();
  const start = '2026-11-11T11:00:00.219Z';
  const end = '2026-11-12T11:00:00.219Z';
  Object.assign(s.report.report_metadata.date_window, { start_time: start, end_time: end });
  s.verify.mockResolvedValueOnce('first-owner');
  s.getAccessToken.mockResolvedValueOnce('first-token');

  await s.review();
  expect(await s.review()).toMatchObject({
    status: 'review',
    venueId: LOCAL_AI_VENUE,
    dishId: LOCAL_AI_DISH,
    timeWindow: { start, end },
  });
  expect(s.verify).toHaveBeenNthCalledWith(1, 'Bearer first-token', s.env);
  expect(s.verify).toHaveBeenNthCalledWith(2, 'Bearer current-token', s.env);
  expect(s.readReport).toHaveBeenNthCalledWith(
    2,
    'current-owner',
    LOCAL_AI_VENUE,
    expect.any(Date),
    s.env,
    'synthetic',
  );
  expect(JSON.parse(s.request.mock.calls[1][1].body)).toEqual(input);
  expect(s.provider).toHaveBeenCalledTimes(2);
});

it('does not dispatch a second request after sign-out', async () => {
  const s = setup();
  s.getAccessToken.mockResolvedValueOnce('first-token').mockResolvedValue(null);

  expect(await s.review()).toMatchObject({ status: 'review' });
  await expect(s.review()).rejects.toThrow('Sign in to request a recommendation.');
  expect(s.request).toHaveBeenCalledTimes(1);
  expect(s.provider).toHaveBeenCalledTimes(1);
});

it('surfaces a generic error and skips the provider when owner membership is revoked', async () => {
  const s = setup();
  s.readReport.mockRejectedValueOnce(new Error('synthetic private membership details'));

  await expect(s.review()).rejects.toThrow(/^Analysis unavailable$/);
  expect(s.verify).toHaveBeenCalledWith('Bearer current-token', s.env);
  expect(s.provider).not.toHaveBeenCalled();
});

it('returns an abstention through the client when report freshness is unknown', async () => {
  const s = setup();
  s.report.report_metadata.freshness.is_stale = null;

  expect(await s.review()).toMatchObject({
    status: 'abstained',
    reason: 'unusable_evidence',
    metric: null,
    value: null,
  });
  expect(s.provider).not.toHaveBeenCalled();
});

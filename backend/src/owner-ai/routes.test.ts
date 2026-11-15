import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from '../../scripts/owner-ai-local-fixture';
import type { Bindings } from '../index';
import { registerOwnerAnalysisRoutes } from './routes';

function setup() {
  const now = new Date('2026-11-12T12:00:00Z');
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError(() => new Response('forbidden', { status: 403 }));
  const verify = vi.fn(async () => 'actor');
  const readReport = vi.fn(async () => localOwnerAiReport(now));
  const fetchImpl = vi.fn(async () =>
    Response.json({
      status: 'completed',
      model: 'gpt-6-luna',
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
    fetchImpl: fetchImpl as typeof fetch,
    now: () => now,
    allowedOrigins: ['http://127.0.0.1:5174'],
    syntheticVenues: [LOCAL_AI_VENUE],
  });
  const env: Bindings = {
    APP_ENV: 'local',
    SYNTHETIC_REPORT_VENUE_ID: LOCAL_AI_VENUE,
    OWNER_AI_RESPONSES_ENABLED: 'true',
    OWNER_AI_OPENAI_API_KEY: 'synthetic',
    OWNER_AI_OPENAI_PROJECT_ID: 'proj_synthetic',
  };
  const run = (
    body: unknown = { dishId: LOCAL_AI_DISH, goal: 'menu' },
    extra: Record<string, string> = {},
  ) =>
    app.request(
      `/api/v1/venues/${LOCAL_AI_VENUE}/ai/analysis`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'application/json',
          ...extra,
        },
        body: JSON.stringify(body),
      },
      env,
    );
  return { app, env, run, verify, readReport, fetchImpl };
}
it('checks owner membership through the reader before sending a single provider request', async () => {
  const s = setup();
  expect((await s.run()).status).toBe(200);
  expect(s.readReport).toHaveBeenCalledWith(
    'actor',
    LOCAL_AI_VENUE,
    expect.any(Date),
    s.env,
    'synthetic',
  );
  expect(s.readReport.mock.invocationCallOrder[0]).toBeLessThan(
    s.fetchImpl.mock.invocationCallOrder[0]!,
  );
});
it('denies absent authentication and revoked membership without a model call', async () => {
  const s = setup();
  expect((await s.run(undefined, { Authorization: '' })).status).toBe(401);
  s.readReport.mockRejectedValue(new Error('revoked'));
  expect((await s.run()).status).toBe(403);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it.each(['production', '', 'staging'])(
  'fails closed in unconfigured environment %s',
  async (appEnv) => {
    const s = setup();
    s.env.APP_ENV = appEnv;
    expect((await s.run()).status).toBe(503);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  },
);
it('rejects browser-supplied metrics/prompts and off-origin requests', async () => {
  const s = setup();
  expect(
    (await s.run({ dishId: LOCAL_AI_DISH, goal: 'menu', metrics: { open_rate: 1 } })).status,
  ).toBe(400);
  expect((await s.run(undefined, { Origin: 'https://untrusted.example' })).status).toBe(403);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('caps local provider calls at ten including concurrent requests', async () => {
  const s = setup();
  const results = await Promise.all(Array.from({ length: 12 }, () => s.run()));
  expect(results.filter((r) => r.status === 200)).toHaveLength(10);
  expect(s.fetchImpl).toHaveBeenCalledTimes(10);
});
it('requires and consumes the staging rate limiter', async () => {
  const s = setup();
  s.env.APP_ENV = 'staging';
  s.env.OWNER_AI_RATE_LIMITER = { limit: vi.fn(async () => ({ success: false })) };
  expect((await s.run()).status).toBe(503);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
